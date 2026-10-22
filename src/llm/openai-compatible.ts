import { z } from "zod"
import { LlmError, type DefinicionHerramienta, type LlmAdapter, type Mensaje, type OpcionesEnvio, type RespuestaLlm } from "./adapter.ts"

export type ConfigOpenAiCompatible = {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
  temperature?: number
}

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

function errorHttp(status: number, cuerpo: string): LlmError {
  const resumen = cuerpo.slice(0, 300)
  if (status === 401 || status === 403) return new LlmError("El proveedor de IA rechazó la credencial configurada en el servidor.", "auth")
  if (status === 429) return new LlmError("El proveedor de IA alcanzó su límite de uso. Espera un minuto e inténtalo de nuevo.", "limite")
  if (status === 400 && /tool|function/i.test(resumen)) return new LlmError(`El modelo generó una llamada a herramienta mal formada: ${resumen}`, "proveedor")
  return new LlmError(`El proveedor de IA respondió con error ${status}.`, "proveedor")
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
    const usarHerramientas = opciones.herramientasHabilitadas !== false && herramientas.length > 0
    const cuerpo = {
      model: this.config.model,
      temperature: this.config.temperature ?? 0,
      messages: mensajes,
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
      toolCalls: (msg?.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments ?? "{}" })),
      usage: { input: parsed.data.usage?.prompt_tokens ?? 0, output: parsed.data.usage?.completion_tokens ?? 0 },
    }
  }
}
