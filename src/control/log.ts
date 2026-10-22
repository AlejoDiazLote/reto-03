import { appendFile, mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { outDir } from "../domain/paths.ts"

export type ResultadoControl = "creada" | "idempotente" | "bloqueada" | "pendiente_confirmacion" | "error"

export type FilaControl = {
  solicitud_id: string
  resultado: ResultadoControl
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
  ts: string
}

const ENCABEZADO = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n"

function csv(valor: string): string {
  return /[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

async function existe(ruta: string): Promise<boolean> {
  try {
    await stat(ruta)
    return true
  } catch {
    return false
  }
}

export async function registrarControl(root: string, fila: FilaControl): Promise<void> {
  const dir = outDir(root)
  await mkdir(dir, { recursive: true })
  const archivo = join(dir, "control.csv")
  const prefijo = (await existe(archivo)) ? "" : ENCABEZADO
  const linea = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? "",
    String(fila.retroactiva),
    fila.bloqueos.join("|"),
    fila.confirmaciones.join("|"),
    fila.ts,
  ]
    .map(csv)
    .join(",")
  await appendFile(archivo, `${prefijo}${linea}\n`, "utf8")
}

const SECRETOS = /^(api[_-]?key|llm[_-]?api[_-]?key|access[_-]?key|authorization|bearer|token|password|secret)$/i

function sanear(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(sanear)
  if (valor && typeof valor === "object") {
    return Object.fromEntries(
      Object.entries(valor as Record<string, unknown>).map(([k, v]) => [k, SECRETOS.test(k) ? "[redactado]" : sanear(v)]),
    )
  }
  return valor
}

export async function registrarEvento(root: string, evento: Record<string, unknown>): Promise<void> {
  try {
    const dir = outDir(root)
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, "log.jsonl"), `${JSON.stringify(sanear({ ts: new Date().toISOString(), ...evento }))}\n`, "utf8")
  } catch {
    return
  }
}
