import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Mensaje } from "../llm/adapter.ts"
import type { Confirmacion } from "../domain/types.ts"

export type LlamadaVisible = {
  id: string
  name: string
  args: unknown
  ok: boolean
  resumen: string
  resultado: unknown
  forzado?: string
}

export type EntradaHistorial =
  | { role: "user"; content: string; ts: string }
  | { role: "assistant"; content: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; ts: string }
  | { role: "error"; content: string; ts: string }

export type ConfirmacionPendiente = { caso: string; confirmaciones: Confirmacion[] }

export type Sesion = {
  id: string
  creada: string
  mensajes: Mensaje[]
  historial: EntradaHistorial[]
  pendiente: ConfirmacionPendiente | null
  tokens: number
  ocupada: boolean
}

const SESION_ID = /^[A-Za-z0-9_-]{6,64}$/

export function idValido(id: string): boolean {
  return SESION_ID.test(id)
}

export class AlmacenSesiones {
  private readonly sesiones = new Map<string, Sesion>()

  constructor(private readonly root: string) {}

  private ruta(id: string): string {
    return join(this.root, "out", "sessions", `${id}.json`)
  }

  async obtener(id: string): Promise<Sesion> {
    if (!idValido(id)) throw new Error("sessionId inválido")
    const enMemoria = this.sesiones.get(id)
    if (enMemoria) return enMemoria
    const sesion = (await this.leerDisco(id)) ?? {
      id,
      creada: new Date().toISOString(),
      mensajes: [],
      historial: [],
      pendiente: null,
      tokens: 0,
      ocupada: false,
    }
    sesion.ocupada = false
    this.sesiones.set(id, sesion)
    return sesion
  }

  async existe(id: string): Promise<Sesion | null> {
    if (!idValido(id)) return null
    return this.sesiones.get(id) ?? (await this.leerDisco(id))
  }

  private async leerDisco(id: string): Promise<Sesion | null> {
    try {
      return JSON.parse(await readFile(this.ruta(id), "utf8")) as Sesion
    } catch {
      return null
    }
  }

  async guardar(sesion: Sesion): Promise<void> {
    try {
      await mkdir(join(this.root, "out", "sessions"), { recursive: true })
      await writeFile(this.ruta(sesion.id), JSON.stringify({ ...sesion, ocupada: false }), "utf8")
    } catch {
      return
    }
  }
}
