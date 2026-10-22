export type ToolCall = { id: string; name: string; arguments: string }

export type Mensaje =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string }

export type DefinicionHerramienta = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type RespuestaLlm = {
  content: string | null
  toolCalls: ToolCall[]
  usage: { input: number; output: number }
}

export type OpcionesEnvio = { herramientasHabilitadas?: boolean; signal?: AbortSignal }

export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones?: OpcionesEnvio): Promise<RespuestaLlm>
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly tipo: "timeout" | "limite" | "auth" | "proveedor" | "config",
  ) {
    super(message)
  }
}
