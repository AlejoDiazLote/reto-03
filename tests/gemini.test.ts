import { expect, test } from "bun:test"
import { aFormatoOpenAi, OpenAiCompatibleAdapter } from "../src/llm/openai-compatible.ts"

test("conserva extra_content de Gemini en una llamada de herramienta", () => {
  const mensaje = aFormatoOpenAi({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call-1",
        name: "oc_validar",
        arguments: '{"caso":"sol-004"}',
        extra: { google: { thought_signature: "firma-cifrada" } },
      },
    ],
  })
  expect(mensaje).toMatchObject({
    tool_calls: [{
      id: "call-1",
      function: { name: "oc_validar" },
      extra_content: { google: { thought_signature: "firma-cifrada" } },
    }],
  })
})

test("reintenta 503 y usa el modelo de respaldo", async () => {
  const original = globalThis.fetch
  const modelos: string[] = []
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const cuerpo = JSON.parse(String(init?.body)) as { model: string }
    modelos.push(cuerpo.model)
    if (cuerpo.model === "principal") return new Response(JSON.stringify({ error: { message: "ocupado" } }), { status: 503 })
    return new Response(JSON.stringify({ choices: [{ message: { content: "listo" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })
  }) as typeof fetch
  try {
    const llm = new OpenAiCompatibleAdapter({ provider: "gemini", baseUrl: "https://test.invalid", apiKey: "key", model: "principal", fallbackModels: ["respaldo"], timeoutMs: 1000, retries: 0 })
    const r = await llm.enviar([{ role: "user", content: "hola" }], [])
    expect(r.content).toBe("listo")
    expect(modelos).toEqual(["principal", "respaldo"])
  } finally {
    globalThis.fetch = original
  }
})
