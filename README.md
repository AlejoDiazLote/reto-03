# Agente conversacional · Órdenes de Compra SAP (Reto 03)

El agente lee el paquete de una solicitud de compra (correo, solicitud, cotización, aprobación y factura), lo valida contra los maestros (reglas RC1–RC10), construye el payload de la OC con su trazabilidad, genera la evidencia de aprobación (TXT + PDF + sha256) y crea la OC en un SAP simulado. Las excepciones se las pregunta a la analista antes de crear.

- **Link de prueba:** `https://reto-03-6wt1.onrender.com` *(el plan gratis de Render tarda unos 30 s en despertar)*
- **Clave de acceso:** ninguna, salvo que se defina `ACCESS_KEY` (en ese caso el chat la pide una vez).

## Requisitos

- [Bun](https://bun.sh) ≥ 1.1. No se necesita nada más: no hay base de datos ni paso de build.

## Levantar en local (un comando)

```bash
cp .env.example .env        # y pon tu LLM_API_KEY de Gemini (gratis en Google AI Studio)
bun install && bun run dev  # http://localhost:3000
```

Sin clave también se puede probar todo el flujo en la UI con el proveedor determinista:

```bash
LLM_PROVIDER=offline bun run dev
```

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `LLM_PROVIDER` | `gemini` | Etiqueta del proveedor (`offline` activa el guion determinista sin modelo) |
| `LLM_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai` | Endpoint compatible con OpenAI de Gemini; puede sustituirse por Groq, OpenRouter u Ollama |
| `LLM_API_KEY` | — | Clave de Google AI Studio. **Solo en el backend**; nunca se envía al front ni a los logs |
| `LLM_MODEL` | `gemini-3.8-flash` | Modelo de Gemini con function calling |
| `LLM_FALLBACK_MODELS` | `gemini-2.5-flash,gemini-2.5-flash-lite` | Modelos que se prueban, en orden, si el principal responde 500/502/503/504 (alta demanda) |
| `MAX_ITERATIONS` | `25` | Tope de iteraciones herramienta→modelo por turno |
| `MAX_TOKENS_SESSION` | `200000` | Tope de tokens por sesión |
| `LLM_TIMEOUT_MS` | `30000` | Timeout de cada llamada al modelo |
| `RATE_LIMIT_PER_MIN` | `20` | Mensajes por minuto por IP |
| `ACCESS_KEY` | — | Opcional. Protege `/api/*` (header `x-access-key`) |
| `PORT` | `3000` | Puerto HTTP |

## Demo sin modelo

```bash
bun install && bun run demo.ts
```

Limpia `out/` y procesa los 6 casos llamando directamente a las herramientas. Luego repite `sol-001` para mostrar la idempotencia y confirma `sol-004`, `sol-005` y `sol-006` con `confirmado=true`. Imprime por caso `apta`, los bloqueos, las confirmaciones, `retroactiva` y el número de OC o el motivo. Al final muestra `out/control.csv`.

## Pruebas y calidad

```bash
bun test          # reglas RC1–RC10, herramientas, ciclo del agente con LLM simulado, sincronía de modulo/
bun run typecheck # tsc estricto, sin any
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → stream SSE con los eventos `thinking`, `tool_call`, `tool_result`, `message`, `confirmation`, `error` y `done`. Con `?stream=0` responde JSON `{ reply, toolCalls[], needsConfirmation }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión (mensajes, llamadas a herramientas y confirmación pendiente) |
| `GET` | `/api/health` | `{ ok, provider, model, configured }`, sin exponer la clave |
| `GET` | `/api/out/:caso/:archivo` | Descarga `aprobacion.pdf`, `aprobacion.txt`, `payload.json` o `trazabilidad.json` |

Ejemplo:

```bash
curl -s -X POST 'localhost:3000/api/chat?stream=0' -H 'content-type: application/json' \
  -d '{"sessionId":"demo-001","message":"Procesa la solicitud sol-004 y no la crees hasta que confirme"}'
```

## Estructura

```
agent/prompt.md                 comportamiento (system prompt)
src/knowledge/ordenes-compra.md conocimiento del proceso
src/tools/oc.ts                 herramientas oc_* (zod, nunca lanzan)
src/domain/                     reglas RC1–RC10, parseo, payload, evidencia (lógica pura)
src/sap/{adapter,mock}.ts       interfaz SapAdapter + mock sobre out/sap/ordenes.jsonl
src/agent/                      ciclo del agente, sesiones, confirmación humana
src/llm/                        interfaz LlmAdapter + OpenAI-compatible + offline
src/server.ts                   API HTTP + estáticos
web/                            chat (HTML + JS plano)
modulo/                         bonus: agente empaquetado (generado: bun run build:modulo)
demo.ts                         herramientas sin modelo
```

Salidas que se generan en `out/`:

- `sap/ordenes.jsonl`
- `control.csv`
- `log.jsonl`
- `sessions/`
- `<caso>/{payload.json, trazabilidad.json, aprobacion.txt, aprobacion.pdf}`

## Despliegue (GitHub → Render)

1. Sube el repo a GitHub.
2. En Render, crea un *Blueprint* que use `render.yaml`. Se despliega con el Dockerfile en el plan gratuito.
3. Define el secreto `LLM_API_KEY` con la clave de Google AI Studio en el panel de Render.
4. Verifica con `GET /api/health`.

`out/` vive en el disco efímero del contenedor: se reinicia con cada despliegue, lo cual es aceptable porque el PRD no exige persistencia.
