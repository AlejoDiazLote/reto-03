import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { casoDir } from "./paths.ts"
import { contieneAprobado, parseCotizacion, parseFactura } from "./parse.ts"
import {
  AprobacionRawSchema,
  CorreoSchema,
  SolicitudSchema,
  type AprobacionRaw,
  type Paquete,
  type Resultado,
} from "./types.ts"

const CorreoRawSchema = CorreoSchema.extend({ adjuntos: z.array(z.string()).optional() })

async function leerTexto(ruta: string): Promise<string | null> {
  try {
    return await readFile(ruta, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
    throw e
  }
}

function parseJson(texto: string, nombre: string): unknown {
  try {
    return JSON.parse(texto)
  } catch {
    throw new Error(`${nombre} no es un JSON válido. Pide al solicitante que reenvíe el archivo.`)
  }
}

function errorZod(nombre: string, error: z.ZodError): string {
  const detalles = error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
  return `${nombre} tiene datos inválidos (${detalles}). Pide al solicitante que corrija el Excel de solicitud.`
}

export async function leerAprobacionRaw(root: string, caso: string): Promise<AprobacionRaw | null> {
  const texto = await leerTexto(join(casoDir(root, caso), "aprobacion.json"))
  if (texto === null) return null
  const r = AprobacionRawSchema.safeParse(parseJson(texto, "aprobacion.json"))
  if (!r.success) throw new Error(errorZod("aprobacion.json", r.error))
  return r.data
}

export async function leerPaquete(root: string, caso: string): Promise<Resultado<Paquete>> {
  try {
    const dir = casoDir(root, caso)
    const faltantes: string[] = []

    const correoTxt = await leerTexto(join(dir, "correo.json"))
    const solicitudTxt = await leerTexto(join(dir, "solicitud.json"))
    if (correoTxt === null && solicitudTxt === null) {
      return { ok: false, error: `No existe el caso "${caso}" (no hay correo ni solicitud). Verifica el nombre, ej. sol-001.` }
    }
    if (solicitudTxt === null) {
      return { ok: false, error: `El caso "${caso}" no trae solicitud (solicitud.xlsx). Pide al solicitante que la adjunte.` }
    }
    if (correoTxt === null) faltantes.push("correo.json")

    const correoParse = correoTxt
      ? CorreoRawSchema.safeParse(parseJson(correoTxt, "correo.json"))
      : null
    if (correoParse && !correoParse.success) return { ok: false, error: errorZod("correo.json", correoParse.error) }

    const solParse = SolicitudSchema.safeParse(parseJson(solicitudTxt, "solicitud.json"))
    if (!solParse.success) return { ok: false, error: errorZod("solicitud.json", solParse.error) }
    const solicitud = solParse.data

    const correoData = correoParse?.success ? correoParse.data : null
    const correo = correoData
      ? { id: correoData.id, de: correoData.de, asunto: correoData.asunto, fecha: correoData.fecha }
      : { id: `${caso}-sin-correo`, de: "desconocido", asunto: "(sin correo)", fecha: solicitud.fecha_solicitud }

    const cotTxt = await leerTexto(join(dir, "cotizacion.txt"))
    if (cotTxt === null) faltantes.push("cotizacion (cotizacion.pdf)")
    const cotizacion = cotTxt === null ? null : parseCotizacion(cotTxt)

    const aprRaw = await leerAprobacionRaw(root, caso)
    if (aprRaw === null) faltantes.push("aprobacion (correo de aprobación del líder)")
    const aprobacion = aprRaw
      ? { de: aprRaw.de, fecha: aprRaw.fecha, aprobado: contieneAprobado(aprRaw.cuerpo), texto: aprRaw.cuerpo }
      : null

    const facTxt = await leerTexto(join(dir, "factura.txt"))
    const facturaAnunciada = correoData?.adjuntos?.some((a) => a.startsWith("factura")) ?? false
    if (facTxt === null && facturaAnunciada) faltantes.push("factura (anunciada en el correo pero no adjunta)")
    const factura = facTxt === null ? null : parseFactura(facTxt)

    return { ok: true, data: { correo, solicitud, cotizacion, aprobacion, factura, faltantes } }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
