import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import ExcelJS from "exceljs"
import { z } from "zod"
import { registrarControl } from "../control/log.ts"
import { escribirEvidencia } from "../domain/evidence.ts"
import { cargarMaestros } from "../domain/maestros.ts"
import { leerAprobacionRaw, leerPaquete } from "../domain/paquete.ts"
import { CASO_REGEX, dentroDe, outCasoDir } from "../domain/paths.ts"
import { construirOrden } from "../domain/payload.ts"
import { validarPaquete } from "../domain/rules.ts"
import { OrdenCompraSchema, type OrdenCompra, type Paquete, type Validacion } from "../domain/types.ts"
import { SapMock } from "../sap/mock.ts"
import type { SapAdapter } from "../sap/adapter.ts"

export type ToolContext = { directory: string; sessionId: string; sap?: SapAdapter }

const caso = z
  .string()
  .regex(CASO_REGEX, "Usa el nombre de la carpeta del caso, ej. sol-001")
  .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, ej. sol-001")

const ok = (data: unknown): string => JSON.stringify({ ok: true, data })
const fallo = (error: unknown): string =>
  JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })

async function seguro(fn: () => Promise<unknown>): Promise<string> {
  try {
    return ok(await fn())
  } catch (e) {
    return fallo(e)
  }
}

async function paqueteDeDisco(root: string, nombre: string): Promise<Paquete> {
  const r = await leerPaquete(root, nombre)
  if (!r.ok) throw new Error(r.error)
  return r.data
}

async function validarCaso(root: string, nombre: string): Promise<{ paquete: Paquete; validacion: Validacion }> {
  const paquete = await paqueteDeDisco(root, nombre)
  const validacion = validarPaquete(paquete, await cargarMaestros(root))
  return { paquete, validacion }
}

function divergencias(recibido: unknown, canonico: unknown, ruta = ""): string[] {
  if (recibido === undefined) return []
  if (typeof canonico !== "object" || canonico === null) {
    return recibido === canonico ? [] : [`${ruta || "(raíz)"}: recibido ${JSON.stringify(recibido)} ≠ ${JSON.stringify(canonico)}`]
  }
  if (typeof recibido !== "object" || recibido === null) return [`${ruta || "(raíz)"}: tipo distinto`]
  const salida: string[] = []
  for (const [k, v] of Object.entries(canonico as Record<string, unknown>)) {
    if (k === "texto") continue
    salida.push(...divergencias((recibido as Record<string, unknown>)[k], v, ruta ? `${ruta}.${k}` : k))
  }
  return salida
}

export const leer_paquete = {
  description:
    "Lee el paquete de un caso (correo, solicitud, cotización, aprobación y factura si existe) y lo devuelve normalizado; los adjuntos ausentes salen como null y se listan en faltantes.",
  args: { caso },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    return seguro(() => paqueteDeDisco(ctx.directory, args.caso))
  },
}

export const validar = {
  description:
    "Valida el paquete de un caso contra los maestros y las reglas de control RC1–RC10; devuelve apta, bloqueos (con acción sugerida), confirmaciones, derivados, retroactiva y el detalle de cada regla.",
  args: {
    caso,
    paquete: z
      .unknown()
      .optional()
      .describe("Opcional. Paquete devuelto por oc_leer_paquete; si se omite se relee del disco (recomendado)."),
  },
  async execute(args: { caso: string; paquete?: unknown }, ctx: ToolContext): Promise<string> {
    return seguro(async () => {
      const { paquete, validacion } = await validarCaso(ctx.directory, args.caso)
      const dif = divergencias(args.paquete, paquete)
      return dif.length > 0
        ? { ...validacion, aviso: `Se ignoró el paquete recibido porque difiere del original en disco: ${dif.slice(0, 5).join("; ")}` }
        : validacion
    })
  },
}

export const construir_payload = {
  description:
    "Construye la orden de compra tal como quedaría en SAP (esquema OrdenCompra validado con zod), la guarda junto a su trazabilidad campo→fuente y devuelve ambas rutas; falla si el caso tiene bloqueos.",
  args: {
    caso,
    paquete: z.unknown().optional().describe("Opcional. Se ignora: el payload siempre se construye desde el disco."),
    derivados: z.unknown().optional().describe("Opcional. Se ignora: los derivados se recalculan desde los maestros."),
  },
  async execute(args: { caso: string; paquete?: unknown; derivados?: unknown }, ctx: ToolContext): Promise<string> {
    return seguro(async () => {
      const { paquete, validacion } = await validarCaso(ctx.directory, args.caso)
      if (!validacion.apta) {
        throw new Error(
          `No se construye el payload: bloqueos ${validacion.bloqueos.map((b) => `${b.codigo} (${b.detalle})`).join("; ")}`,
        )
      }
      const aprobacion = await leerAprobacionRaw(ctx.directory, args.caso)
      if (!aprobacion) throw new Error("Falta el correo de aprobación.")
      const { orden, trazabilidad } = construirOrden(paquete, validacion, await cargarMaestros(ctx.directory), aprobacion)
      const dir = outCasoDir(ctx.directory, args.caso)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "payload.json"), JSON.stringify(orden, null, 2), "utf8")
      await writeFile(join(dir, "trazabilidad.json"), JSON.stringify(trazabilidad, null, 2), "utf8")
      return {
        orden,
        valor_total: paquete.solicitud.valor_total,
        confirmaciones_pendientes: validacion.confirmaciones,
        derivados: validacion.derivados,
        ruta_payload: `out/${args.caso}/payload.json`,
        ruta_trazabilidad: `out/${args.caso}/trazabilidad.json`,
      }
    })
  },
}

export const generar_evidencia = {
  description:
    "Genera la evidencia de aprobación del caso (aprobacion.txt con encabezados, cuerpo y sha256, y aprobacion.pdf) en out/<caso>/ y devuelve las rutas y el hash.",
  args: { caso },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    return seguro(async () => {
      const aprobacion = await leerAprobacionRaw(ctx.directory, args.caso)
      if (!aprobacion) throw new Error("El caso no tiene correo de aprobación; no hay evidencia que generar. Pide al solicitante la aprobación del líder.")
      return escribirEvidencia(ctx.directory, args.caso, aprobacion)
    })
  },
}

async function leerPayloadGuardado(root: string, nombre: string): Promise<OrdenCompra | null> {
  try {
    const texto = await readFile(join(outCasoDir(root, nombre), "payload.json"), "utf8")
    return OrdenCompraSchema.parse(JSON.parse(texto))
  } catch {
    return null
  }
}

export const crear = {
  description:
    "Crea la orden de compra en SAP (simulado) usando el payload construido; solo crea si no hay bloqueos y, si hay confirmaciones, solo con confirmado=true después de que el usuario confirmó; es idempotente por solicitud_id y registra cada intento en el log de control.",
  args: {
    caso,
    payload: z.unknown().optional().describe("Opcional. Se ignora: se usa el payload guardado por oc_construir_payload."),
    confirmado: z
      .boolean()
      .optional()
      .describe("true solo si el usuario confirmó explícitamente las confirmaciones en su último mensaje."),
  },
  async execute(args: { caso: string; payload?: unknown; confirmado?: boolean }, ctx: ToolContext): Promise<string> {
    const root = ctx.directory
    const sap = ctx.sap ?? new SapMock(root)
    const ts = new Date().toISOString()
    let solicitudId = args.caso
    try {
      const { paquete, validacion } = await validarCaso(root, args.caso)
      solicitudId = paquete.solicitud.solicitud_id
      const base = {
        solicitud_id: solicitudId,
        retroactiva: validacion.retroactiva,
        bloqueos: validacion.bloqueos.map((b) => b.codigo),
        confirmaciones: validacion.confirmaciones.map((c) => c.codigo),
        ts,
      }

      const existente = await sap.buscarOrdenPorReferencia(solicitudId)
      if (existente) {
        await registrarControl(root, { ...base, resultado: "idempotente", numero_oc: existente.numero_oc })
        return ok({ numero_oc: existente.numero_oc, fecha: null, idempotente: true, mensaje: `La solicitud ${solicitudId} ya tenía la OC ${existente.numero_oc}; no se creó otra.` })
      }

      if (!validacion.apta) {
        await registrarControl(root, { ...base, resultado: "bloqueada", numero_oc: null })
        return JSON.stringify({ ok: false, error: `OC no creada por bloqueos: ${validacion.bloqueos.map((b) => `${b.codigo}: ${b.detalle} → ${b.accion}`).join(" | ")}`, resultado: "bloqueada", bloqueos: validacion.bloqueos })
      }

      if (validacion.confirmaciones.length > 0 && args.confirmado !== true) {
        await registrarControl(root, { ...base, resultado: "pendiente_confirmacion", numero_oc: null })
        return JSON.stringify({
          ok: false,
          error: "La OC requiere confirmación humana antes de crearse.",
          resultado: "pendiente_confirmacion",
          confirmaciones: validacion.confirmaciones,
        })
      }

      const aprobacion = await leerAprobacionRaw(root, args.caso)
      if (!aprobacion) throw new Error("Falta el correo de aprobación.")
      const guardado = await leerPayloadGuardado(root, args.caso)
      const recalculado = construirOrden(paquete, validacion, await cargarMaestros(root), aprobacion).orden
      if (guardado && JSON.stringify(guardado) !== JSON.stringify(recalculado)) {
        throw new Error("El payload guardado no coincide con los datos actuales del caso. Ejecuta de nuevo oc_construir_payload.")
      }
      const confirmables = new Set(validacion.confirmaciones.map((c) => c.codigo))
      const orden: OrdenCompra = {
        ...recalculado,
        excepciones: recalculado.excepciones.map((e) => ({
          ...e,
          confirmado_por: confirmables.has(e.codigo) ? `analista:${ctx.sessionId}` : null,
        })),
      }
      const creada = await sap.crearOrden(orden)
      await registrarControl(root, { ...base, resultado: "creada", numero_oc: creada.numero_oc })
      return ok({ ...creada, idempotente: false, retroactiva: validacion.retroactiva, excepciones: orden.excepciones })
    } catch (e) {
      await registrarControl(root, { solicitud_id: solicitudId, resultado: "error", numero_oc: null, retroactiva: false, bloqueos: [], confirmaciones: [], ts }).catch(() => undefined)
      return fallo(e)
    }
  },
}

function celda(valor: ExcelJS.CellValue): string | number | boolean | null {
  if (valor === null || valor === undefined) return null
  if (valor instanceof Date) return valor.toISOString().slice(0, 10)
  if (typeof valor === "object") {
    if ("result" in valor) return celda(valor.result as ExcelJS.CellValue)
    if ("text" in valor) return String(valor.text)
    if ("richText" in valor) return valor.richText.map((r) => r.text).join("")
    return null
  }
  return valor
}

export const leer_excel = {
  description:
    "Lee un archivo .xlsx (por ejemplo la solicitud original) dentro de fixtures/ u out/ y devuelve sus filas como objetos usando la primera fila como encabezados.",
  args: {
    ruta: z.string().min(1).describe("Ruta relativa a la raíz del proyecto, dentro de fixtures/ u out/, ej. out/solicitudes-xlsx/sol-001.xlsx"),
    hoja: z.string().optional().describe("Nombre de la hoja; si se omite se usa la primera."),
  },
  async execute(args: { ruta: string; hoja?: string }, ctx: ToolContext): Promise<string> {
    return seguro(async () => {
      if (!args.ruta.toLowerCase().endsWith(".xlsx")) throw new Error("Solo se leen archivos .xlsx")
      const ruta = dentroDe(ctx.directory, args.ruta, ["fixtures", "out"])
      const libro = new ExcelJS.Workbook()
      await libro.xlsx.readFile(ruta)
      const hoja = args.hoja ? libro.getWorksheet(args.hoja) : libro.worksheets[0]
      if (!hoja) throw new Error(`No existe la hoja ${args.hoja ?? "(primera)"}`)
      const encabezados: string[] = []
      const filas: Array<Record<string, string | number | boolean | null>> = []
      hoja.eachRow((row, n) => {
        const valores = (row.values as ExcelJS.CellValue[]).slice(1).map(celda)
        if (n === 1) {
          encabezados.push(...valores.map((v, i) => (v === null ? `col_${i + 1}` : String(v).trim())))
          return
        }
        filas.push(Object.fromEntries(encabezados.map((h, i) => [h, valores[i] ?? null])))
      })
      return { hoja: hoja.name, encabezados, filas }
    })
  },
}
