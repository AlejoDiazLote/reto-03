import { join, normalize } from "node:path"
import { z } from "zod"
import { Agente, type EventoAgente } from "./agent/loop.ts"
import { AlmacenSesiones } from "./agent/session.ts"
import { config } from "./config.ts"
import { CASO_REGEX } from "./domain/paths.ts"
import type { LlmAdapter } from "./llm/adapter.ts"
import { OfflineAdapter } from "./llm/offline.ts"
import { OpenAiCompatibleAdapter } from "./llm/openai-compatible.ts"

const root = join(import.meta.dir, "..")
const webDir = join(root, "web")

const llm: LlmAdapter =
  config.provider === "offline"
    ? new OfflineAdapter()
    : new OpenAiCompatibleAdapter({
        provider: config.provider,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        timeoutMs: config.timeoutMs,
      })
const agente = new Agente({ root, llm, maxIterations: config.maxIterations, maxTokensSession: config.maxTokensSession })
const sesiones = new AlmacenSesiones(root)

const ChatSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, "sessionId inválido"),
  message: z.string().trim().min(1, "El mensaje está vacío").max(4000, "El mensaje es demasiado largo"),
})

const ventanas = new Map<string, number[]>()
function limitado(ip: string): boolean {
  const ahora = Date.now()
  const recientes = (ventanas.get(ip) ?? []).filter((t) => ahora - t < 60_000)
  recientes.push(ahora)
  ventanas.set(ip, recientes)
  return recientes.length > config.rateLimitPerMin
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } })

function autorizado(req: Request): boolean {
  if (!config.accessKey) return true
  const url = new URL(req.url)
  return req.headers.get("x-access-key") === config.accessKey || url.searchParams.get("key") === config.accessKey
}

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
}
const tipo = (ruta: string): string => TIPOS[ruta.slice(ruta.lastIndexOf("."))] ?? "application/octet-stream"

async function estatico(pathname: string): Promise<Response> {
  const relativo = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "")
  const archivo = Bun.file(join(webDir, relativo))
  if (!(await archivo.exists())) return new Response("No encontrado", { status: 404 })
  return new Response(archivo, { headers: { "content-type": tipo(relativo), "cache-control": "no-cache" } })
}

const ARCHIVOS_OUT = new Set(["aprobacion.txt", "aprobacion.pdf", "payload.json", "trazabilidad.json"])

async function salida(caso: string, archivo: string): Promise<Response> {
  if (!CASO_REGEX.test(caso) || !ARCHIVOS_OUT.has(archivo)) return json({ ok: false, error: "Archivo no permitido" }, 404)
  const f = Bun.file(join(root, "out", caso, archivo))
  if (!(await f.exists())) return json({ ok: false, error: "El archivo aún no existe" }, 404)
  return new Response(f, { headers: { "content-type": tipo(archivo) } })
}

async function chat(req: Request, ip: string): Promise<Response> {
  if (limitado(ip)) return json({ ok: false, error: "Demasiados mensajes por minuto. Espera un momento." }, 429)
  let cuerpo: unknown
  try {
    cuerpo = await req.json()
  } catch {
    return json({ ok: false, error: "El cuerpo debe ser JSON" }, 400)
  }
  const parsed = ChatSchema.safeParse(cuerpo)
  if (!parsed.success) return json({ ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") }, 400)
  const { sessionId, message } = parsed.data
  const sesion = await sesiones.obtener(sessionId)
  if (sesion.ocupada) return json({ ok: false, error: "La sesión ya está procesando un mensaje." }, 409)
  sesion.ocupada = true

  const stream = new URL(req.url).searchParams.get("stream") !== "0"
  if (!stream) {
    try {
      const r = await agente.turno(sesion, message, () => undefined)
      return json(r)
    } finally {
      sesion.ocupada = false
      await sesiones.guardar(sesion)
    }
  }

  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emitir = (e: EventoAgente): void => {
        try {
          controller.enqueue(encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`))
        } catch {
          return
        }
      }
      try {
        await agente.turno(sesion, message, emitir)
      } finally {
        sesion.ocupada = false
        await sesiones.guardar(sesion)
        try {
          controller.close()
        } catch {
          return
        }
      }
    },
  })
  return new Response(body, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" },
  })
}

const server = Bun.serve({
  port: config.port,
  idleTimeout: 255,
  async fetch(req, srv) {
    const url = new URL(req.url)
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? srv.requestIP(req)?.address ?? "local"
    try {
      if (url.pathname === "/api/health") {
        return json({ ok: true, provider: llm.provider, model: llm.model, configured: llm.provider === "offline" || config.apiKey.length > 0, accessKeyRequired: config.accessKey.length > 0 })
      }
      if (url.pathname.startsWith("/api/")) {
        if (!autorizado(req)) return json({ ok: false, error: "Clave de acceso inválida" }, 401)
        if (url.pathname === "/api/chat" && req.method === "POST") return await chat(req, ip)
        const ses = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
        if (ses?.[1] && req.method === "GET") {
          const s = await sesiones.existe(ses[1])
          return s
            ? json({ id: s.id, creada: s.creada, historial: s.historial, pendiente: s.pendiente, tokens: s.tokens })
            : json({ ok: false, error: "Sesión no encontrada" }, 404)
        }
        const out = url.pathname.match(/^\/api\/out\/([^/]+)\/([^/]+)$/)
        if (out?.[1] && out[2] && req.method === "GET") return await salida(out[1], out[2])
        return json({ ok: false, error: "Ruta no encontrada" }, 404)
      }
      return await estatico(url.pathname)
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : "Error interno" }, 500)
    }
  },
})

console.log(`Agente OC SAP en http://localhost:${server.port} · proveedor ${llm.provider} · modelo ${llm.model}${config.apiKey ? "" : " · SIN LLM_API_KEY"}`)
