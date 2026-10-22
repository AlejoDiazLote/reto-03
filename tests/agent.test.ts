import { beforeEach, describe, expect, test } from "bun:test"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agente, type EventoAgente } from "../src/agent/loop.ts"
import type { Sesion } from "../src/agent/session.ts"
import type { LlmAdapter, Mensaje, OpcionesEnvio, RespuestaLlm, ToolCall } from "../src/llm/adapter.ts"
import * as oc from "../src/tools/oc.ts"

const proyecto = join(import.meta.dir, "..")
let root = ""

beforeEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = await mkdtemp(join(tmpdir(), "oc-"))
  for (const d of ["fixtures", "agent", "src/knowledge"]) await cp(join(proyecto, d), join(root, d), { recursive: true })
})

let n = 0
const llamada = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `c${++n}`, name, arguments: JSON.stringify(args) })

class LlmGuionado implements LlmAdapter {
  readonly provider = "fake"
  readonly model = "guion"
  vistos: Mensaje[][] = []
  constructor(private readonly guion: Array<ToolCall[] | string>) {}
  async enviar(mensajes: Mensaje[], _h: unknown, opciones?: OpcionesEnvio): Promise<RespuestaLlm> {
    this.vistos.push(mensajes)
    if (opciones?.herramientasHabilitadas === false && typeof this.guion[0] !== "string") {
      return { content: "[sin herramientas] resumen", toolCalls: [], usage: { input: 1, output: 1 } }
    }
    const paso = this.guion.shift() ?? "fin"
    return typeof paso === "string"
      ? { content: paso, toolCalls: [], usage: { input: 10, output: 10 } }
      : { content: null, toolCalls: paso, usage: { input: 10, output: 10 } }
  }
}

const sesion = (): Sesion => ({ id: "test-session", creada: "", mensajes: [], historial: [], pendiente: null, tokens: 0, ocupada: false })

describe("ciclo del agente", () => {
  test("sol-004: pide confirmación y solo crea tras 'confirmo'", async () => {
    const llm = new LlmGuionado([
      [llamada("oc_validar", { caso: "sol-004" })],
      [llamada("oc_construir_payload", { caso: "sol-004" })],
      [llamada("oc_crear", { caso: "sol-004", confirmado: true })],
      "¿Confirmas que cree la OC?",
      [llamada("oc_crear", { caso: "sol-004", confirmado: true })],
      "OC creada",
    ])
    const agente = new Agente({ root, llm, maxIterations: 25, maxTokensSession: 100000 })
    const s = sesion()
    const eventos: EventoAgente[] = []
    const t1 = await agente.turno(s, "procesa sol-004", (e) => eventos.push(e))
    expect(t1.needsConfirmation).toBe(true)
    expect(t1.toolCalls.at(-1)?.forzado).toBeDefined()
    expect(eventos.some((e) => e.type === "confirmation")).toBe(true)

    const t2 = await agente.turno(s, "confirmo", () => undefined)
    const crear = t2.toolCalls.find((c) => c.name === "oc_crear")
    expect(crear?.ok).toBe(true)
    expect((crear?.resultado as { data: { numero_oc: string } }).data.numero_oc).toBe("4500000001")
    expect(t2.needsConfirmation).toBe(false)
  })

  test("un mensaje que no confirma no habilita confirmado=true", async () => {
    const llm = new LlmGuionado([
      [llamada("oc_crear", { caso: "sol-004" })],
      "¿Confirmas?",
      [llamada("oc_crear", { caso: "sol-004", confirmado: true })],
      "listo",
    ])
    const agente = new Agente({ root, llm, maxIterations: 25, maxTokensSession: 100000 })
    const s = sesion()
    await agente.turno(s, "procesa sol-004", () => undefined)
    const t2 = await agente.turno(s, "no, espera", () => undefined)
    expect(t2.toolCalls[0]?.ok).toBe(false)
    expect(t2.toolCalls[0]?.forzado).toBeDefined()
  })

  test("argumentos inválidos vuelven al modelo y la sesión sigue", async () => {
    const llm = new LlmGuionado([[llamada("oc_validar", { caso: "../etc" })], [llamada("oc_inexistente", {})], "no pude"])
    const agente = new Agente({ root, llm, maxIterations: 25, maxTokensSession: 100000 })
    const t = await agente.turno(sesion(), "valida ../etc", () => undefined)
    expect(t.toolCalls.map((c) => c.ok)).toEqual([false, false])
    expect(t.reply).toBe("no pude")
  })

  test("tope de iteraciones", async () => {
    const guion: Array<ToolCall[] | string> = Array.from({ length: 5 }, () => [llamada("oc_leer_paquete", { caso: "sol-001" })])
    guion.push("resumen con lo que tengo")
    const llm = new LlmGuionado(guion)
    const agente = new Agente({ root, llm, maxIterations: 3, maxTokensSession: 100000 })
    const t = await agente.turno(sesion(), "procesa", () => undefined)
    expect(t.toolCalls).toHaveLength(3)
    expect(llm.vistos).toHaveLength(4)
    expect(t.reply).toBe("[sin herramientas] resumen")
  })
})

describe("herramientas", () => {
  test("idempotencia y bloqueo no crean OC", async () => {
    const ctx = { directory: root, sessionId: "t" }
    await oc.construir_payload.execute({ caso: "sol-001" }, ctx)
    const a = JSON.parse(await oc.crear.execute({ caso: "sol-001" }, ctx))
    const b = JSON.parse(await oc.crear.execute({ caso: "sol-001" }, ctx))
    expect(a.data.numero_oc).toBe("4500000001")
    expect(b.data).toMatchObject({ numero_oc: "4500000001", idempotente: true })
    const c = JSON.parse(await oc.crear.execute({ caso: "sol-002", confirmado: true }, ctx))
    expect(c.ok).toBe(false)
  })
  test("evidencia con sha256", async () => {
    const r = JSON.parse(await oc.generar_evidencia.execute({ caso: "sol-001" }, { directory: root, sessionId: "t" }))
    expect(r.data.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await Bun.file(join(root, "out/sol-001/aprobacion.pdf")).exists()).toBe(true)
  })
  test("caso inexistente devuelve error legible", async () => {
    const r = JSON.parse(await oc.leer_paquete.execute({ caso: "sol-999" }, { directory: root, sessionId: "t" }))
    expect(r.ok).toBe(false)
  })
})
