import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { registrarEvento } from "../control/log.ts"
import type { Confirmacion } from "../domain/types.ts"
import { LlmError, type LlmAdapter, type Mensaje, type ToolCall } from "../llm/adapter.ts"
import type { SapAdapter } from "../sap/adapter.ts"
import { casoMencionado, esConfirmacion } from "./confirm.ts"
import { formatearErrorZod, registrarHerramientas, type HerramientaRegistrada } from "./registry.ts"
import type { LlamadaVisible, Sesion } from "./session.ts"
import { resumirResultado } from "./summary.ts"

export type EventoAgente =
  | { type: "thinking"; iteracion: number }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; call: LlamadaVisible }
  | { type: "message"; content: string }
  | { type: "confirmation"; caso: string; confirmaciones: Confirmacion[] }
  | { type: "error"; message: string }
  | { type: "done"; needsConfirmation: boolean; tokens: number }

export type ResultadoTurno = { reply: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; error?: string }

export type OpcionesAgente = {
  root: string
  llm: LlmAdapter
  maxIterations: number
  maxTokensSession: number
  sap?: SapAdapter
}

type Json = Record<string, unknown>

export async function cargarSystemPrompt(root: string): Promise<string> {
  const [prompt, conocimiento] = await Promise.all([
    readFile(join(root, "agent", "prompt.md"), "utf8"),
    readFile(join(root, "src", "knowledge", "ordenes-compra.md"), "utf8"),
  ])
  return `${prompt.trim()}\n\n---\n\n# Conocimiento del proceso\n\n${conocimiento.trim()}`
}

function parsearJson(texto: string): Json | null {
  try {
    const v: unknown = JSON.parse(texto || "{}")
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null
  } catch {
    return null
  }
}

function confirmacionesDe(resultado: Json): { apta: boolean; confirmaciones: Confirmacion[] } {
  const data = (resultado.ok === true ? resultado.data : resultado) as Json | undefined
  const confirmaciones = (data?.confirmaciones ?? data?.confirmaciones_pendientes ?? []) as Confirmacion[]
  const apta = resultado.ok === true ? data?.apta !== false : resultado.resultado === "pendiente_confirmacion"
  return { apta, confirmaciones: Array.isArray(confirmaciones) ? confirmaciones : [] }
}

const PIDE_CONFIRMACION = /¿[^?]*\b(confirm|procedo|creo la|crear la|deseas que|quieres que)[^?]*\?/i

export class Agente {
  private readonly herramientas: Map<string, HerramientaRegistrada>
  private systemPrompt: string | null = null

  constructor(private readonly opciones: OpcionesAgente) {
    this.herramientas = registrarHerramientas()
  }

  get definiciones() {
    return [...this.herramientas.values()].map((h) => h.definicion)
  }

  private async prompt(): Promise<string> {
    this.systemPrompt ??= await cargarSystemPrompt(this.opciones.root)
    return this.systemPrompt
  }

  async turno(sesion: Sesion, mensaje: string, emitir: (e: EventoAgente) => void): Promise<ResultadoTurno> {
    const ts = new Date().toISOString()
    const llamadas: LlamadaVisible[] = []
    sesion.historial.push({ role: "user", content: mensaje, ts })
    await registrarEvento(this.opciones.root, { tipo: "user", sessionId: sesion.id, mensaje })

    const pendienteAlInicio = sesion.pendiente
    const mencionado = casoMencionado(mensaje)
    const casoConfirmado =
      pendienteAlInicio && esConfirmacion(mensaje) && (mencionado === null || mencionado === pendienteAlInicio.caso)
        ? pendienteAlInicio.caso
        : null
    if (pendienteAlInicio && !casoConfirmado) sesion.pendiente = null

    if (sesion.tokens >= this.opciones.maxTokensSession) {
      return this.cerrarConError(sesion, llamadas, emitir, "Esta sesión alcanzó el tope de tokens configurado. Abre una sesión nueva para continuar.")
    }

    const nota = casoConfirmado
      ? `\n\n[Nota del sistema: el usuario confirmó explícitamente las excepciones pendientes del caso ${casoConfirmado}. Puedes llamar oc_crear con confirmado=true para ese caso.]`
      : pendienteAlInicio
        ? `\n\n[Nota del sistema: el mensaje del usuario NO es una confirmación de ${pendienteAlInicio.caso}; no llames oc_crear con confirmado=true.]`
        : ""
    sesion.mensajes.push({ role: "user", content: mensaje + nota })

    let needsConfirmation = false
    let herramientasHabilitadas = true
    try {
      const system: Mensaje = { role: "system", content: await this.prompt() }
      for (let i = 1; ; i++) {
        const tope = i > this.opciones.maxIterations
        if (tope) {
          sesion.mensajes.push({ role: "user", content: "[Nota del sistema: se alcanzó el tope de iteraciones de este turno. Responde con lo que tienes, sin llamar herramientas, e indica qué falta.]" })
          herramientasHabilitadas = false
        }
        emitir({ type: "thinking", iteracion: i })
        const respuesta = await this.llamarModelo([system, ...sesion.mensajes], herramientasHabilitadas)
        sesion.tokens += respuesta.usage.input + respuesta.usage.output

        if (respuesta.toolCalls.length === 0 || !herramientasHabilitadas) {
          const texto = respuesta.content?.trim() || "No tengo una respuesta para mostrar."
          sesion.mensajes.push({ role: "assistant", content: texto })
          needsConfirmation = sesion.pendiente !== null && (needsConfirmation || PIDE_CONFIRMACION.test(texto) || sesion.pendiente !== pendienteAlInicio)
          return await this.cerrar(sesion, texto, llamadas, needsConfirmation, emitir)
        }

        sesion.mensajes.push({ role: "assistant", content: respuesta.content ?? null, tool_calls: respuesta.toolCalls })
        for (const call of respuesta.toolCalls) {
          const visible = await this.ejecutarLlamada(call, sesion, casoConfirmado, emitir)
          llamadas.push(visible)
          sesion.mensajes.push({ role: "tool", tool_call_id: call.id, name: call.name, content: JSON.stringify(visible.resultado) })
          if (call.name === "oc_crear" && visible.ok) sesion.pendiente = null
          if (call.name === "oc_crear" && (visible.resultado as Json).resultado === "pendiente_confirmacion") {
            needsConfirmation = true
            herramientasHabilitadas = false
          }
        }
      }
    } catch (e) {
      const mensajeError = e instanceof LlmError ? e.message : `Error interno del agente: ${e instanceof Error ? e.message : String(e)}`
      return this.cerrarConError(sesion, llamadas, emitir, mensajeError)
    }
  }

  private async llamarModelo(mensajes: Mensaje[], herramientasHabilitadas: boolean) {
    try {
      return await this.opciones.llm.enviar(mensajes, this.definiciones, { herramientasHabilitadas })
    } catch (e) {
      if (e instanceof LlmError && e.tipo === "proveedor" && /herramienta/.test(e.message)) {
        return this.opciones.llm.enviar(mensajes, this.definiciones, { herramientasHabilitadas })
      }
      throw e
    }
  }

  private async ejecutarLlamada(call: ToolCall, sesion: Sesion, casoConfirmado: string | null, emitir: (e: EventoAgente) => void): Promise<LlamadaVisible> {
    const args = parsearJson(call.arguments)
    emitir({ type: "tool_call", id: call.id, name: call.name, args: args ?? call.arguments })
    const herramienta = this.herramientas.get(call.name)
    let resultado: Json
    let forzado: string | undefined
    let argsFinales: unknown = args

    if (!herramienta) {
      resultado = { ok: false, error: `La herramienta ${call.name} no existe. Disponibles: ${[...this.herramientas.keys()].join(", ")}` }
    } else if (!args) {
      resultado = { ok: false, error: "Los argumentos no son un JSON de objeto válido." }
    } else {
      const validado = herramienta.schema.safeParse(args)
      if (!validado.success) {
        resultado = { ok: false, error: `Argumentos inválidos: ${formatearErrorZod(validado.error)}` }
      } else {
        const datos = { ...validado.data } as Json
        if (call.name === "oc_crear" && datos.confirmado === true && datos.caso !== casoConfirmado) {
          datos.confirmado = false
          forzado = "confirmado=true ignorado: el usuario no ha confirmado este caso en su último mensaje."
        }
        argsFinales = datos
        const texto = await herramienta.ejecutar(datos, { directory: this.opciones.root, sessionId: sesion.id, ...(this.opciones.sap ? { sap: this.opciones.sap } : {}) })
        resultado = parsearJson(texto) ?? { ok: false, error: "La herramienta devolvió una respuesta ilegible." }
        if (forzado) resultado = { ...resultado, aviso_servidor: forzado }
        this.actualizarPendiente(call.name, String(datos.caso ?? ""), resultado, sesion)
      }
    }

    const visible: LlamadaVisible = {
      id: call.id,
      name: call.name,
      args: argsFinales,
      ok: resultado.ok === true,
      resumen: resumirResultado(call.name, resultado),
      resultado,
      ...(forzado ? { forzado } : {}),
    }
    emitir({ type: "tool_result", call: visible })
    await registrarEvento(this.opciones.root, { tipo: "tool", sessionId: sesion.id, name: call.name, args: argsFinales, ok: visible.ok, resumen: visible.resumen, forzado })
    return visible
  }

  private actualizarPendiente(nombre: string, caso: string, resultado: Json, sesion: Sesion): void {
    if (!caso || !["oc_validar", "oc_construir_payload", "oc_crear"].includes(nombre)) return
    if (nombre === "oc_crear" && resultado.ok === true) return
    const { apta, confirmaciones } = confirmacionesDe(resultado)
    if (apta && confirmaciones.length > 0) sesion.pendiente = { caso, confirmaciones }
    else if (nombre === "oc_validar" && sesion.pendiente?.caso === caso) sesion.pendiente = null
  }

  private async cerrar(sesion: Sesion, texto: string, llamadas: LlamadaVisible[], needsConfirmation: boolean, emitir: (e: EventoAgente) => void): Promise<ResultadoTurno> {
    sesion.historial.push({ role: "assistant", content: texto, toolCalls: llamadas, needsConfirmation, ts: new Date().toISOString() })
    emitir({ type: "message", content: texto })
    if (needsConfirmation && sesion.pendiente) emitir({ type: "confirmation", caso: sesion.pendiente.caso, confirmaciones: sesion.pendiente.confirmaciones })
    emitir({ type: "done", needsConfirmation, tokens: sesion.tokens })
    await registrarEvento(this.opciones.root, { tipo: "assistant", sessionId: sesion.id, needsConfirmation, tokens: sesion.tokens })
    return { reply: texto, toolCalls: llamadas, needsConfirmation }
  }

  private async cerrarConError(sesion: Sesion, llamadas: LlamadaVisible[], emitir: (e: EventoAgente) => void, mensaje: string): Promise<ResultadoTurno> {
    sesion.historial.push({ role: "error", content: mensaje, ts: new Date().toISOString() })
    if (llamadas.length > 0) {
      sesion.historial.push({ role: "assistant", content: "(El turno se interrumpió; estas son las herramientas que alcanzaron a ejecutarse.)", toolCalls: llamadas, needsConfirmation: false, ts: new Date().toISOString() })
    }
    const ultimo = sesion.mensajes.at(-1)
    if (ultimo && (ultimo.role === "tool" || (ultimo.role === "assistant" && ultimo.tool_calls))) {
      sesion.mensajes.push({ role: "assistant", content: `(Turno interrumpido por un error: ${mensaje})` })
    }
    emitir({ type: "error", message: mensaje })
    emitir({ type: "done", needsConfirmation: false, tokens: sesion.tokens })
    await registrarEvento(this.opciones.root, { tipo: "error", sessionId: sesion.id, mensaje })
    return { reply: "", toolCalls: llamadas, needsConfirmation: false, error: mensaje }
  }
}
