import { mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import ExcelJS from "exceljs"
import * as oc from "./src/tools/oc.ts"
import type { Bloqueo, Confirmacion, Validacion } from "./src/domain/types.ts"

const root = import.meta.dir
const ctx = { directory: root, sessionId: "demo" }
const CASOS = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"]

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string; resultado?: string; confirmaciones?: Confirmacion[] }
type Creada = { numero_oc: string; idempotente: boolean }

const parse = <T>(s: string): Respuesta<T> => JSON.parse(s) as Respuesta<T>

type Fila = { paso: string; caso: string; apta: string; bloqueos: string; confirmaciones: string; retroactiva: string; resultado: string }
const filas: Fila[] = []

async function procesar(caso: string, paso: string, confirmado?: boolean): Promise<void> {
  const v = parse<Validacion>(await oc.validar.execute({ caso }, ctx))
  if (!v.ok) {
    filas.push({ paso, caso, apta: "-", bloqueos: "-", confirmaciones: "-", retroactiva: "-", resultado: `ERROR: ${v.error}` })
    return
  }
  const val = v.data
  let resultado: string
  if (val.apta) {
    await oc.construir_payload.execute({ caso }, ctx)
    await oc.generar_evidencia.execute({ caso }, ctx)
  }
  const args = confirmado === undefined ? { caso } : { caso, confirmado }
  const c = parse<Creada>(await oc.crear.execute(args, ctx))
  if (c.ok) resultado = `OC ${c.data.numero_oc}${c.data.idempotente ? " (idempotente: ya existía)" : ""}`
  else if (c.resultado === "pendiente_confirmacion") resultado = "PENDIENTE: requiere confirmación humana"
  else resultado = `NO CREADA: ${val.bloqueos.map((b: Bloqueo) => b.accion).join(" / ") || c.error}`
  filas.push({
    paso,
    caso,
    apta: String(val.apta),
    bloqueos: val.bloqueos.map((b) => `${b.codigo}: ${b.detalle}`).join("\n") || "—",
    confirmaciones: val.confirmaciones.map((x) => `${x.codigo}: ${x.detalle}`).join("\n") || "—",
    retroactiva: String(val.retroactiva),
    resultado,
  })
}

async function demoExcel(): Promise<string> {
  const sol = JSON.parse(await readFile(join(root, "fixtures/reto-03/solicitudes/sol-001/solicitud.json"), "utf8")) as Record<string, string | number>
  const libro = new ExcelJS.Workbook()
  const hoja = libro.addWorksheet("Solicitud")
  hoja.addRow(Object.keys(sol))
  hoja.addRow(Object.values(sol))
  await mkdir(join(root, "out/xlsx"), { recursive: true })
  await libro.xlsx.writeFile(join(root, "out/xlsx/sol-001.xlsx"))
  const r = parse<{ filas: Array<Record<string, unknown>> }>(await oc.leer_excel.execute({ ruta: "out/xlsx/sol-001.xlsx" }, ctx))
  return r.ok ? `oc_leer_excel → ${r.data.filas.length} fila(s); solicitud_id=${String(r.data.filas[0]?.solicitud_id)}` : `oc_leer_excel → error: ${r.error}`
}

async function main(): Promise<void> {
  await rm(join(root, "out"), { recursive: true, force: true })
  console.log("Demo sin modelo · Agente Órdenes de Compra SAP\n")

  for (const caso of CASOS) await procesar(caso, "1. primera pasada")
  await procesar("sol-001", "2. idempotencia")
  await procesar("sol-004", "3. confirmación explícita (confirmado=true)", true)
  await procesar("sol-005", "3. confirmación explícita (confirmado=true)", true)
  await procesar("sol-006", "3. confirmación explícita (confirmado=true)", true)

  for (const f of filas) {
    console.log(`── ${f.caso} · ${f.paso}`)
    console.log(`   apta: ${f.apta} · retroactiva: ${f.retroactiva}`)
    console.log(`   bloqueos: ${f.bloqueos.replace(/\n/g, "\n             ")}`)
    console.log(`   confirmaciones: ${f.confirmaciones.replace(/\n/g, "\n                   ")}`)
    console.log(`   → ${f.resultado}\n`)
  }

  const errorCaso = parse<unknown>(await oc.leer_paquete.execute({ caso: "sol-999" }, ctx))
  console.log(`Manejo de errores · oc_leer_paquete(sol-999) → ${errorCaso.ok ? "ok" : errorCaso.error}`)
  console.log(await demoExcel())

  console.log("\nResumen")
  console.table(
    filas.map((f) => ({ caso: f.caso, paso: f.paso, apta: f.apta, retroactiva: f.retroactiva, resultado: f.resultado })),
  )
  console.log("\nArchivos: out/sap/ordenes.jsonl · out/control.csv · out/<caso>/{payload,trazabilidad}.json · out/<caso>/aprobacion.{txt,pdf}")
  console.log("\nout/control.csv:\n" + (await readFile(join(root, "out/control.csv"), "utf8")))
}

await main()
