import { expect, test } from "bun:test"
import { aFormatoOpenAi } from "../src/llm/openai-compatible.ts"

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
