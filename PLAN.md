# PLAN — Reto 03 · Agente "Órdenes de Compra SAP"

## 1. Decisiones tomadas
| Tema | Decisión | Por qué |
|---|---|---|
| Runtime | Bun + TypeScript estricto (sin `any`) | Lo sugiere el PRD; ejecuta TS sin paso de compilación y trae el servidor HTTP incluido |
| LLM | Adaptador propio + implementación **compatible con OpenAI** (`fetch`, sin SDK). Por defecto **Groq `llama-3.3-70b-versatile`** (gratuito) | Cambiar a Gemini, OpenRouter u Ollama solo requiere cambiar variables de entorno; el ciclo del agente no se toca |
| Front | HTML + JS plano en `web/`, servido por el mismo backend, con **SSE** | Un solo comando y sin paso de build |
| Deploy | Repo en GitHub → **Render** (plan gratis, Dockerfile `oven/bun`) | GitHub Pages no puede correr el backend ni guardar la clave del modelo |
| Opcionales | PDF de la aprobación (`pdf-lib`), `oc_leer_excel` (`exceljs`), SSE, `modulo/` (bonus) | Elegidos por el usuario |
| Dependencias | `zod`, `pdf-lib`, `exceljs`. Nada más | Cada una se justifica en SOLUCION.md |

## 2. Estructura final
```
reto-03/
├── agent/prompt.md                  # comportamiento (system prompt)
├── src/
│   ├── server.ts                    # Bun.serve: API + estáticos + SSE
│   ├── agent/loop.ts                # ciclo del agente (tope de iteraciones y tokens)
│   ├── agent/session.ts             # sesiones en memoria + volcado a out/sessions/
│   ├── agent/confirm.ts             # detección de "confirmo" y estado pendiente
│   ├── agent/registry.ts            # carga de tools/*.ts → nombre <archivo>_<export>, zod → JSON Schema
│   ├── llm/adapter.ts               # interfaz LlmAdapter.enviar(mensajes, herramientas)
│   ├── llm/openai-compatible.ts     # implementación (Groq por defecto), timeout con AbortController
│   ├── tools/oc.ts                  # leer_paquete, validar, construir_payload, generar_evidencia, crear, leer_excel
│   ├── domain/                      # lógica pura, testeable
│   │   ├── types.ts                 # esquemas zod: Solicitud, Paquete, OrdenCompra, Maestros
│   │   ├── parse.ts                 # parseo de cotizacion.txt y factura.txt (montos con formato "11.400.000", NIT "900.555.111-2")
│   │   ├── maestros.ts              # carga y caché de los fixtures de maestros
│   │   ├── rules.ts                 # RC1..RC10, una función por regla
│   │   ├── payload.ts               # construcción + trazabilidad
│   │   └── evidence.ts              # txt + sha256 + pdf
│   ├── sap/adapter.ts               # interfaz SapAdapter (texto exacto del PRD)
│   ├── sap/mock.ts                  # out/sap/ordenes.jsonl + secuencial 4500000001
│   ├── control/log.ts               # out/control.csv + out/log.jsonl
│   └── knowledge/ordenes-compra.md  # conocimiento del proceso (reglas, maestros, glosario)
├── web/index.html, app.js, styles.css
├── fixtures/reto-03/{maestros,solicitudes}   # se MUEVEN aquí los que hoy están en la raíz
├── modulo/agent.md, modulo/tools/oc.ts, modulo/skill/ordenes-compra/SKILL.md
├── demo.ts, tests/*.test.ts (bun test)
├── Dockerfile, render.yaml, .env.example, .gitignore
├── package.json, tsconfig.json, README.md, SOLUCION.md
```

## 3. Dominio — reglas y resultado esperado
Cálculo de cada regla, con fechas comparadas como `YYYY-MM-DD` en hora de Bogotá:
- **RC1**: el proveedor se busca por NIT; los NIT se normalizan a solo dígitos sin dígito de verificación. Si no hay NIT, se busca por nombre normalizado (sin tildes, minúsculas, sin puntuación). Debe existir y estar `activo`. → bloqueo
- **RC2**: la aprobación debe existir, su texto debe cumplir `/\baprobado\b/i` y `de` debe estar en los aprobadores del centro de costo. → bloqueo
- **RC3**: `valor_total` ≤ tope del aprobador. Solo se evalúa si RC2 identificó al aprobador; si no, se marca "no evaluable" con su motivo. → bloqueo
- **RC4**: la subárea debe pertenecer al centro de costo. → bloqueo
- **RC5**: diferencia > 2 % entre cotización y solicitud, o cotización ausente. → confirmación con ambos valores
- **RC6**: IVA ausente → se toma el default del proveedor, se registra como derivado y se pide confirmación
- **RC7**: condiciones de pago ausentes → se toman del proveedor y se registra como derivado
- **RC8**: factura con fecha anterior a `fecha_solicitud` → `retroactiva=true` y confirmación
- **RC9**: aprobación con fecha anterior a `fecha_solicitud` → confirmación
- **RC10**: `|cantidad × valor_unitario − valor_total| > 1` → bloqueo

Datos adicionales que se derivan, cada uno con su trazabilidad:
- **Unidad**: `H` si la descripción contiene "hora"; `MES` si contiene "mensual" o "mes"; `UN` en los demás casos.
- **Descripción**: se recorta a 40 caracteres y se registra la excepción `TXT40` con el texto original.

| Caso | Esperado |
|---|---|
| sol-001 | apta, sin confirmaciones → OC 4500000001; segunda corrida → misma OC, `idempotente:true` |
| sol-002 | Bloqueo RC1 (NIT 901999000 no está en los maestros) → acción: crear el proveedor en SAP o cambiarlo |
| sol-003 | Bloqueo RC2: fvargas no es aprobador de CC-2020. RC3 no evaluable (74M > tope de rtorres de 30M) → acción: pedir la aprobación a rtorres o a quien tenga ese tope |
| sol-004 | Confirmación RC5: 25.000.000 vs 26.500.000 (6 %); unidad H → tras confirmar, OC 4500000002 |
| sol-005 | Confirmación RC8: factura del 2026-08-10, anterior a la solicitud del 2026-08-27; `retroactiva=true` en control.csv |
| sol-006 | Proveedor encontrado por nombre; IVA C1 derivado (requiere confirmación); condiciones Z030 derivadas (solo se informan) |

## 4. Herramientas (`src/tools/oc.ts`)
Cada herramienta exporta `{description, args (zod con .describe), execute(args, ctx) → string}` y nunca lanza: todo va en `try/catch` y devuelve `{ok:false,error}`. Las rutas se resuelven desde `ctx.directory`. El argumento `caso` se valida con `/^[a-z0-9-]+$/` para evitar path traversal.

| Tool | Notas |
|---|---|
| `oc_leer_paquete {caso}` | Devuelve el Paquete 7.2. Un adjunto faltante sale como `null` con su nombre en `faltantes[]`. Un JSON malformado se reporta como error legible |
| `oc_validar {caso, paquete?}` | Si no recibe paquete, lo relee del disco. Esto evita que el modelo altere los datos. Devuelve `{apta, bloqueos[{codigo,detalle,accion}], confirmaciones[{codigo,detalle,valores}], derivados, retroactiva}` |
| `oc_construir_payload {caso}` | Arma la OC desde disco + validación y la verifica con `OrdenCompraSchema.parse`. Escribe `out/<caso>/payload.json` y `trazabilidad.json` (campo → `solicitud`/`cotizacion`/`maestro.x`/`derivado`) |
| `oc_generar_evidencia {caso}` | Escribe `aprobacion.txt` (encabezados + cuerpo + sha256) y `aprobacion.pdf`. Devuelve `{ruta, ruta_pdf, sha256}` |
| `oc_crear {caso, confirmado?}` | Revalida en el servidor. Bloqueos → no crea. Confirmaciones sin `confirmado` → resultado `pendiente`. Usa el **payload guardado** (el modelo no puede editar montos). Antes de crear revisa `buscarOrdenPorReferencia` para la idempotencia. Escribe una fila en control.csv en todos los casos |
| `oc_leer_excel {ruta}` | Con `exceljs`. Solo acepta rutas dentro de `fixtures/` u `out/`. Devuelve `{filas[]}` |

Decisión clave: el contrato del PRD pasa `paquete`, `derivados` y `payload` como argumentos. Se aceptan esos argumentos, pero el servidor **recalcula y compara contra disco**. Si hay diferencias, se ignora lo que mandó el modelo y queda registrado. Esto mitiga el riesgo "el modelo arregla el monto" (sección 10 del PRD).

## 5. Ciclo del agente (`src/agent/loop.ts`)
1. El system prompt se arma con `agent/prompt.md` + `src/knowledge/ordenes-compra.md`.
2. Bucle: `llm.enviar(mensajes, tools)`. Si el modelo pide herramientas, se valida cada una con zod; si no pasa, el error vuelve al modelo. Luego se ejecuta, se emite el evento SSE `tool_call`/`tool_result` y se escribe en `out/log.jsonl`. El bucle repite hasta recibir texto o llegar a `MAX_ITERATIONS` (25). Al llegar al tope, se hace una última llamada sin herramientas que resume lo que hay y lo que falta.
3. **Confirmación humana impuesta en el servidor (CA3)**:
   - Si `oc_crear` responde `pendiente`, la sesión guarda `pendingConfirmation={caso, confirmaciones}`, el turno termina con `needsConfirmation:true` y el front lo resalta.
   - En el turno siguiente, `confirmado=true` solo se acepta si el mensaje del usuario es afirmativo (`/^(s[ií]|confirmo|ok|dale|procede|apruebo)/i`) y existe una confirmación pendiente para ese caso. Si no, el servidor fuerza `confirmado=false`.
   - Quien confirma se guarda en `confirmado_por` (`analista:<sessionId>`).
4. Costos: tope de tokens por sesión (`MAX_TOKENS_SESSION`, se suma `usage` de cada respuesta) y límite de mensajes por minuto por IP.
5. Errores: timeout del LLM (`LLM_TIMEOUT_MS`, 30 s), 429 o 5xx → mensaje claro en el chat; la sesión sigue viva (CA5).

## 6. API
- `POST /api/chat {sessionId,message}` → SSE con eventos `thinking`, `tool_call`, `tool_result`, `message`, `confirmation`, `error`, `done`. Con `?stream=0` responde JSON `{reply, toolCalls[], needsConfirmation}`.
- `GET /api/sessions/:id` → historial completo.
- `GET /api/health` → `{ok, provider, model}` sin la clave.
- `GET /api/out/:caso/:archivo` → descarga de la evidencia y el payload (solo nombres permitidos).
- Opcional: protección con `ACCESS_KEY` (header o query); si se usa, se documenta en el README.

## 7. Front (`web/`)
- Burbujas de chat e indicador "pensando…".
- Tarjetas plegables por herramienta (nombre, argumentos y resumen del resultado, por ejemplo "apta: no · 1 bloqueo").
- **Banner ámbar de confirmación** con botones "Confirmo" y "Cancelar".
- Tablas markdown renderizadas con un mini-renderer propio (sin dependencias); el texto se escapa contra XSS.
- `sessionId` en `localStorage`; botón "Nueva sesión"; botones de ejemplo ("Procesa sol-004…").

## 8. `demo.ts`
Limpia `out/` y procesa los casos sol-001 a sol-006 llamando directamente a las herramientas, sin LLM. Luego vuelve a correr sol-001 (idempotencia) y sol-004 con `confirmado:true`. Imprime una tabla con caso, apta, bloqueos, confirmaciones, retroactiva y número de OC o motivo. La salida es determinista.

## 9. `modulo/` (bonus, sin piezas divergentes)
- `modulo/agent.md`: frontmatter (`description`, `mode: primary`, `permission {edit: deny, bash: deny}`) y como cuerpo el **contenido generado** desde `agent/prompt.md`.
- `modulo/tools/oc.ts`: `export * from "../../src/tools/oc"` (re-exporta, no copia).
- `modulo/skill/ordenes-compra/SKILL.md`: frontmatter + `src/knowledge/ordenes-compra.md`.
- El script `bun run build:modulo` genera los dos `.md`, y un test verifica que coinciden con sus fuentes.

## 10. Orden de implementación
1. Andamiaje: `package.json`, `tsconfig` estricto, mover los fixtures a `fixtures/reto-03/`, `.gitignore`, `.env.example`.
2. `domain/` (tipos, parse, maestros, rules) y tests de cada regla.
3. `sap/` y `control/`; tools `oc.ts`; `demo.ts` → verificar la tabla esperada.
4. Adaptador LLM, `registry` y `loop` con confirmación forzada; `server.ts` con SSE.
5. `agent/prompt.md` y `knowledge/ordenes-compra.md`.
6. Front.
7. PDF, `leer_excel` y `modulo/`.
8. Dockerfile, `render.yaml`, repo en GitHub, deploy en Render (variable `GROQ_API_KEY` como secreto).
9. README.md y SOLUCION.md (las 12 secciones).
10. Memoria `.perxia/` (estado y plan).

## 11. Variables (`.env.example`)
`LLM_BASE_URL=https://api.groq.com/openai/v1`, `LLM_API_KEY=`, `LLM_MODEL=llama-3.3-70b-versatile`, `LLM_PROVIDER=groq`, `MAX_ITERATIONS=25`, `MAX_TOKENS_SESSION=200000`, `LLM_TIMEOUT_MS=30000`, `PORT=3000`, `ACCESS_KEY=` (opcional).

## 12. Verificación
- `bun test`: RC1 a RC10, parseo de montos/NIT, idempotencia, esquema zod del payload, `modulo/` sincronizado.
- `bun run demo.ts` dos veces → misma tabla (salvo timestamps) y los resultados de la sección 3.
- `bun run typecheck` (`tsc --noEmit`) sin errores; grep de `any` = 0.
- `bun run dev` → chat local: correr el prompt de ejemplo de sol-004, verificar el banner, escribir "confirmo" y obtener la OC + ruta de la evidencia; probar "confirmo" sin pendiente → el servidor no crea la OC.
- Revisar que la clave no aparezca en `/api/health`, en `out/log.jsonl` ni en el bundle del front.
- Probar el link de Render en una sesión nueva.

## 13. Riesgos del plan
- Llama en Groq a veces llama mal a las herramientas → validación con zod + mensaje de error al modelo + reintento. Modelo alternativo por variable de entorno (Gemini Flash).
- Límite de requests del plan gratis de Groq → mensaje claro en el chat; el demo no depende del LLM.
- Disco efímero de Render → `out/` se pierde al reiniciar; aceptable (el PRD no pide persistencia) y se documenta.
