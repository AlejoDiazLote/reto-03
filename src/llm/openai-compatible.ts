import { z } from "zod"
import { LlmError, type DefinicionHerramienta, type LlmAdapter, type Mensaje, type OpcionesEnvio, type RespuestaLlm } from "./adapter.ts"

export type ConfigOpenAiCompatible = {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
  temperature?: number
  fallbackModels?: string[]
  retries?: number
  retryDelayMs?: number
}

const REINTENTABLE = new Set([500, 502, 503, 504])
const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const RespuestaSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string().nullable().optional() }),
                extra_content: z.record(z.string(), z.unknown()).optional(),
              }),
            )
            .nullable()
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).optional(),
})

export function aFormatoOpenAi(m: Mensaje): Record<string, unknown> {
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.tool_calls.map((t) => ({
        id: t.id,
        type: "function",
        function: { name: t.name, arguments: t.arguments },
        ...(t.extra ? { extra_content: t.extra } : {}),
      })),
    }
  }
  if (m.role === "assistant") return { role: "assistant", content: m.content ?? "" }
  return m
}

function detalleProveedor(cuerpo: string): string {
  try {
    const json = JSON.parse(cuerpo) as { error?: { message?: unknown } }
    const mensaje = json.error?.message
    if (typeof mensaje === "string") return mensaje.slice(0, 300)
  } catch {
    return cuerpo.slice(0, 300)
  }
  return cuerpo.slice(0, 300)
}

function errorHttp(status: number, cuerpo: string): LlmError {
  const resumen = detalleProveedor(cuerpo)
  if (status === 401 || status === 403) return new LlmError("El proveedor de IA rechazó la credencial configurada en el servidor.", "auth")
  if (status === 429) return new LlmError("El proveedor de IA alcanzó su límite de uso. Espera un minuto e inténtalo de nuevo.", "limite")
  if (REINTENTABLE.has(status)) return new LlmError(`El modelo no está disponible temporalmente (${status}): ${resumen}`, "proveedor", true)
  if (status === 400 && /tool|function/i.test(resumen)) return new LlmError(`El modelo generó una llamada a herramienta mal formada: ${resumen}`, "proveedor")
  return new LlmError(`El proveedor de IA respondió con error ${status}: ${resumen}`, "proveedor")
}

export class OpenAiCompatibleAdapter implements LlmAdapter {
  readonly provider: string
  readonly model: string

  constructor(private readonly config: ConfigOpenAiCompatible) {
    this.provider = config.provider
    this.model = config.model
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio = {}): Promise<RespuestaLlm> {
    if (!this.config.apiKey && !/localhost|127\.0\.0\.1/.test(this.config.baseUrl)) {
      throw new LlmError("No hay clave del proveedor de IA configurada en el servidor (LLM_API_KEY).", "config")
    }
    const modelos = [this.config.model, ...(this.config.fallbackModels ?? []).filter((m) => m !== this.config.model)]
    const reintentos = this.config.retries ?? 2
    const espera = this.config.retryDelayMs ?? 1500
    let ultimo: LlmError | null = null
    for (const modelo of modelos) {
      for (let intento = 0; intento <= reintentos; intento++) {
        try {
          return await this.enviarModelo(modelo, mensajes, herramientas, opciones)
        } catch (e) {
          if (!(e instanceof LlmError) || !e.reintentable) throw e
          ultimo = e
          if (intento < reintentos) await esperar(espera * 2 ** intento)
        }
      }
    }
    throw ultimo ?? new LlmError("El proveedor de IA no está disponible.", "proveedor")
  }

  private async enviarModelo(modelo: string, mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<RespuestaLlm> {
    const usarHerramientas = opciones.herramientasHabilitadas !== false && herramientas.length > 0
    const cuerpo = {
      model: modelo,
      temperature: this.config.temperature ?? 0,
      messages: mensajes.map(aFormatoOpenAi),
      ...(usarHerramientas
        ? { tools: herramientas.map((h) => ({ type: "function", function: h })), tool_choice: "auto", parallel_tool_calls: false }
        : {}),
    }
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const signal = opciones.signal ? AbortSignal.any([timeout, opciones.signal]) : timeout
    let res: Response
    try {
      res = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify(cuerpo),
        signal,
      })
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new LlmError(`El proveedor de IA no respondió en ${Math.round(this.config.timeoutMs / 1000)} s.`, "timeout")
      }
      throw new LlmError("No fue posible conectar con el proveedor de IA.", "proveedor")
    }
    const texto = await res.text()
    if (!res.ok) throw errorHttp(res.status, texto)
    let json: unknown
    try {
      json = JSON.parse(texto)
    } catch {
      throw new LlmError("El proveedor de IA devolvió una respuesta que no es JSON.", "proveedor")
    }
    const parsed = RespuestaSchema.safeParse(json)
    if (!parsed.success) throw new LlmError("La respuesta del proveedor de IA no tiene el formato esperado.", "proveedor")
    const msg = parsed.data.choices[0]?.message
    return {
      content: msg?.content ?? null,
      toolCalls: (msg?.tool_calls ?? []).map((t) => ({
        id: t.id,
        name: t.function.name,
        arguments: t.function.arguments ?? "{}",
        ...(t.extra_content ? { extra: t.extra_content } : {}),
      })),
      usage: { input: parsed.data.usage?.prompt_tokens ?? 0, output: parsed.data.usage?.completion_tokens ?? 0 },
    }
  }
}
