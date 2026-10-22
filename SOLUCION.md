# SOLUCIÓN · Agente "Órdenes de Compra SAP"

## 1. Problema en una frase

La analista administrativa digita a mano en SAP cada orden de compra. Para eso valida de memoria proveedor, aprobador, topes y centros de costo, lo que cuesta tiempo y errores que solo aparecen en el cierre contable. Además, la dirección no sabe cuántas OC se crean después de la factura.

Les duele a la analista (tiempo), a contabilidad y auditoría (control y evidencia) y a la dirección (no puede medir el desvío).

## 2. Arquitectura

```mermaid
flowchart LR
  W[web/ chat HTML+JS] -- POST /api/chat · SSE --> S[src/server.ts]
  S --> L[src/agent/loop.ts<br/>ciclo + confirmación]
  L --> A[src/llm/adapter.ts<br/>LlmAdapter]
  A --> G[openai-compatible.ts<br/>Groq · Gemini · OpenRouter · Ollama]
  A --> O[offline.ts<br/>guion determinista]
  L --> R[src/agent/registry.ts<br/>zod → JSON Schema]
  R --> T[src/tools/oc.ts]
  T --> D[src/domain/<br/>reglas · payload · evidencia]
  T --> SAP[src/sap/mock.ts<br/>SapAdapter]
  D --> F[(fixtures/ solo lectura)]
  SAP --> OUT[(out/ escritura)]
  T --> OUT
```

| Capa | Dónde | Qué contiene |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Orden del flujo, reglas que no se rompen y formato de respuesta |
| Conocimiento | `src/knowledge/ordenes-compra.md` | Proceso, maestros, RC1–RC10, retroactivas y payload. Se concatena al system prompt |
| Ejecución | `src/tools/oc.ts` → `src/domain/*` | Lógica pura y determinista, testeable sin servidor |

Un cambio de reglas de negocio toca `src/domain/rules.ts` y el `.md` de conocimiento, no el servidor ni el ciclo.

## 3. Ciclo del agente

`Agente.turno()` (`src/agent/loop.ts`) funciona así:

1. Agrega el mensaje del usuario y decide **en el servidor** si ese mensaje confirma la excepción pendiente de la sesión.
   - Una expresión regular afirmativa sin negación (`confirm.ts`) marca el mensaje como confirmación.
   - Si el mensaje nombra otro caso, no cuenta como confirmación de este.
   - El resultado se le comunica al modelo con una nota del sistema.
2. Bucle `enviar(mensajes, herramientas)`. En cada llamada a herramienta:
   - Valida los argumentos con zod (`.strict()`). Si fallan, el error vuelve al modelo como resultado de la herramienta.
   - Ejecuta la herramienta.
   - Emite `tool_call` y `tool_result` por SSE.
   - Escribe la llamada en `out/log.jsonl`.
3. **Tope de iteraciones (CA1)**: al superar `MAX_ITERATIONS` se hace una última llamada **sin herramientas**, con la instrucción de responder con lo que hay y lo que falta.
4. **Confirmación humana (CA3)** con doble candado:
   - **Candado del modelo**: el prompt prohíbe `confirmado=true` sin confirmación.
   - **Candado del servidor**: si el modelo envía `confirmado=true` para un caso que el usuario no confirmó en *este* mensaje, el servidor lo cambia a `false`. La tarjeta de la herramienta lo muestra como "forzado".
   - Cuando `oc_crear` responde `pendiente_confirmacion`, se desactivan las herramientas para el resto del turno, el turno termina con una pregunta y llega `needsConfirmation=true`. El front muestra entonces la burbuja resaltada y el banner con "Confirmo / Cancelar".
5. **Errores (CA5)**:
   - Las fallas de herramienta vuelven al modelo.
   - Las fallas del proveedor (timeout, 429, 401, formato) se traducen a lenguaje claro en `LlmError` y se muestran como evento `error`.
   - La sesión sigue viva: el historial se cierra de forma consistente.
6. **Costo**:
   - Tope de tokens por sesión, sumando el `usage` de cada respuesta.
   - Rate limit por IP.
   - Mensajes de máximo 4.000 caracteres.
   - Un solo turno en curso por sesión.
   - Temperatura 0.

## 4. Elección del modelo

- **Proveedor**: Groq, modelo `llama-3.3-70b-versatile`, a través de un adaptador **compatible con OpenAI** escrito con `fetch`, sin SDK.
- **Por qué**:
  - Tiene plan gratuito, que es lo que pidió el usuario.
  - Su latencia es muy baja (cientos de tokens por segundo), así que un caso completo de 5 herramientas responde en pocos segundos.
  - Soporta *function calling*.
- **Flexibilidad**: el mismo adaptador sirve para Gemini, OpenRouter u Ollama cambiando solo `LLM_BASE_URL` y `LLM_MODEL`. El ciclo no se toca.
- **Proveedor `offline`**: también implementa `LlmAdapter`. Permite demostrar la UI sin clave y prueba que cambiar de proveedor no afecta el ciclo.

**Costo estimado por caso** (cálculo de orden de magnitud):

| Concepto | Valor aproximado |
|---|---|
| Llamadas al modelo por caso | 6 |
| Tokens de entrada (system prompt + historial creciente + resultados JSON) | ~20 k |
| Tokens de salida | ~1,5 k |
| Costo en el plan gratuito | US$ 0 |
| Costo con la tarifa de pago de Groq para este modelo (US$ 0,59 / 0,79 por M) | ≈ US$ 0,013 por caso |
| Costo con un modelo frontera tipo Claude Sonnet o GPT-4.1 | ≈ US$ 0,05–0,08 por caso |

## 5. Matriz de controles

Todas las reglas viven en `src/domain/rules.ts`, una función por regla, y cada una deja su estado en `reglas[]`: `ok`, `bloqueo`, `confirmacion`, `derivado` o `no_evaluable`.

| Regla | Implementación | Caso |
|---|---|---|
| RC1 | El NIT se normaliza a dígitos sin DV (`900.555.111-2` → `900555111`). Sin NIT, se compara el nombre sin tildes, puntuación ni sufijo societario. Inactivo → bloqueo | sol-002 bloquea; sol-006 se resuelve por nombre |
| RC2 | Aprobación presente + `/\baprobad[oa]\b/` (excluye "no aprobado") + remitente en los aprobadores del centro | sol-003: fvargas no es aprobador de CC-2020 |
| RC3 | `valor_total ≤ tope` del aprobador. Si RC2 falla queda `no_evaluable`, y la acción sugerida lista quién sí tiene tope | sol-003: nadie en CC-2020 tiene tope para 74 M |
| RC4 | `subareas.includes(subarea)` | Probado en tests |
| RC5 | `|cot − sol| / sol > 2 %` → confirmación con ambos valores. Sin cotización → confirmación | sol-004: 25 M vs 26,5 M (6 %) |
| RC6 | IVA ausente → `indicador_iva_default` como derivado + confirmación | sol-006: C1 |
| RC7 | Condición de pago ausente → default del proveedor; solo se informa | sol-006: Z030 |
| RC8 | Factura anterior a `fecha_solicitud` → `retroactiva=true` + confirmación + columna en `control.csv` | sol-005 |
| RC9 | Fecha de aprobación (en hora de Bogotá) anterior a la solicitud → confirmación | Probado en tests |
| RC10 | `|cantidad × unitario − total| > 1` → bloqueo | Probado en tests |

**La más difícil: RC2/RC3 en sol-003.** Si se evalúan de forma independiente, sol-003 da *dos* bloqueos que se contradicen: "no es aprobador" y "supera el tope de un aprobador que no es el suyo". Decidí que RC3 solo se evalúe contra el aprobador que firmó y que, si RC2 falla, quede `no_evaluable`. La acción sugerida calcula quién del centro sí tiene tope; en sol-003 la conclusión es que nadie y hay que escalar. El texto de la "aprobación" de comercial es convincente ("Aprobado desde comercial…"), así que una lectura laxa la habría aceptado.

Otro punto delicado fue la **cotización con IVA incluido**: el total de la cotización ya trae IVA y la solicitud también. Por eso se comparan totales contra totales y no la base gravable.

**Garantía contra "arreglar montos"**: `oc_validar`, `oc_construir_payload` y `oc_crear` aceptan los argumentos del contrato (`paquete`, `derivados`, `payload`), pero **siempre recalculan desde disco**. Si el paquete que envía el modelo difiere del real, se ignora y se reporta como `aviso`. `oc_crear` además compara el payload guardado con el recalculado antes de enviarlo al SAP.

## 6. Diseño del adaptador SAP real

**Opción elegida:**

- Principal: **OData V2 `API_PURCHASEORDER_PROCESS_SRV`** (S/4HANA), expuesto a través de **SAP Integration Suite / API Management** o de un Cloud Connector si el SAP es on-premise.
- Alternativa si el sistema es ECC: **`BAPI_PO_CREATE1`** vía RFC desde un microservicio intermedio (node-rfc o SAP JCo).

Razones:

1. Es una API pública y documentada por SAP. Valida con la misma lógica que la transacción ME21N (sin "atajos" de tablas).
2. Funciona por HTTPS, lo que facilita el tránsito por red y la observabilidad.
3. Como la viabilidad no está confirmada, `SapAdapter` aísla la decisión: el agente no cambia, solo la implementación.

**Mapeo (OData):**

| Payload 7.4 | `A_PurchaseOrder` / `A_PurchaseOrderItem` |
|---|---|
| `sociedad` | `CompanyCode` |
| `organizacion_compras` | `PurchasingOrganization` (+ `PurchasingGroup` desde la configuración) |
| `proveedor.codigo_sap` | `Supplier` |
| `moneda` | `DocumentCurrency` |
| `condiciones_pago` | `PaymentTerms` |
| `referencia.solicitud_id` | `CorrespncExternalReference` (o el campo Z acordado) — **clave de idempotencia** |
| `posiciones[].numero` | `PurchaseOrderItem` (10, 20, …) |
| `descripcion` | `PurchaseOrderItemText` (40 caracteres) |
| `cantidad` | `OrderQuantity` |
| `unidad` | `PurchaseOrderQuantityUnit` (UN→`EA`, H→`H`, MES→`MON`, según la tabla T006 del cliente) |
| `precio_unitario` | `NetPriceAmount` + `NetPriceQuantity=1` |
| `indicador_iva` | `TaxCode` |
| `centro_costo` | `to_AccountAssignment.CostCenter` con `AccountAssignmentCategory = 'K'` |
| `subarea` | `to_AccountAssignment` → elemento PEP, centro de beneficio o un campo de clasificación, según cómo modele el cliente la subárea |
| `aprobador`, `excepciones` | Texto de cabecera (`to_PurchaseOrderNote`) |
| PDF de evidencia | Se adjunta con **Attachment Service** (`API_CV_ATTACHMENT_SRV`, objeto `BUS2012`) |

Para BAPI: `POHEADER`, `POITEM`, `POACCOUNT` (con sus estructuras `X`), `POTEXTHEADER` y luego `BAPI_TRANSACTION_COMMIT`.

**Autenticación y credenciales:**

- OAuth 2.0 *client credentials* (Integration Suite) o certificado X.509 de un **usuario técnico** con un rol mínimo: crear y leer pedidos, consultar proveedores.
- Las credenciales viven en un gestor de secretos (Azure Key Vault o AWS Secrets Manager) y se inyectan **solo en el servicio adaptador**.
- El agente y el prompt nunca ven las credenciales. El modelo solo llama `oc_crear`.

**Idempotencia y errores parciales:**

1. Antes de crear, `buscarOrdenPorReferencia` (`$filter` por la referencia externa). Si la OC ya existe, se devuelve sin crear otra.
2. Se envía `Repeatability-Request-ID` (header OData) con un UUID determinista derivado de `solicitud_id`, para que un reintento por timeout no duplique la OC.
3. Si hay timeout sin respuesta, se reconsulta por la referencia antes de reintentar. Reintentos con backoff, máximo 3.
4. **Error parcial**: si la OC se crea pero falla el adjunto PDF o la nota, el resultado queda `creada_con_pendientes`. Se registra en `control.csv` y la subida del adjunto se reintenta de forma idempotente por hash. No se borra la OC.
5. Los errores de negocio de SAP (mensajes `E` del BAPIRET2 o del `sap-message`) se traducen al chat como bloqueos con su acción sugerida. Ejemplo: "proveedor bloqueado para la sociedad 1000".

**Plan B si no hay conexión:**

1. **Archivo de carga masiva**: `oc_crear` genera un CSV o XLSX con el layout de *Migration Cockpit* / LSMW ("Purchase Order – open"), uno por lote. La analista lo sube una vez al día.
2. **OC lista para pegar**: el payload en el orden exacto de los campos de ME21N, más el PDF de evidencia ya generado. Así la digitación pasa de unos 10 minutos a copiar y pegar en menos de 2.
3. **Automatización GUI** como último recurso (SAP GUI Scripting o RPA), siempre con el mismo payload validado.

En los tres casos se conserva lo más valioso: las validaciones RC1–RC10, la evidencia y la medición de retroactivas.

## 7. Lectura del proceso: OC retroactivas

Una OC retroactiva no es un problema administrativo: es un **gasto comprometido sin control previo**. La compra se negoció sin cotización comparada, sin verificar el tope del aprobador antes de comprometer y, a veces, con un proveedor no homologado. La OC termina siendo un trámite para poder pagar la factura, no un control.

Recomendación a la dirección:

1. **Medir antes de prohibir.** Con `control.csv` ya se puede reportar el porcentaje de OC retroactivas por centro de costo, aprobador y proveedor. Propongo un tablero mensual durante dos meses para identificar dónde se concentra (normalmente pocos centros y compras recurrentes).
2. **Tolerar con marca, pero con dueño.** Mientras se mide: la retroactiva se crea solo con confirmación explícita y un motivo. Por encima de un umbral (por ejemplo, 2 millones o una recurrencia mensual) exige aprobación del siguiente nivel.
3. **Atacar la causa:**
   - Para compras recurrentes (papelería, licencias, nube): **pedidos marco o contratos** con OC abierta anual, de modo que la factura llega contra una OC existente.
   - Para lo demás: comunicar a proveedores "**sin OC no se radica factura**" (*No PO, No Pay*). Es la política estándar y la que más rápido reduce el indicador.
4. **Meta sugerida**: bajar del nivel actual a menos del 10 % en un trimestre.

## 8. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Las herramientas **recalculan desde disco** e ignoran `paquete`/`payload` enviados por el modelo | Confiar en los argumentos del modelo (contrato literal) | Elimina el riesgo de que el modelo "arregle" montos. Cuesta unas lecturas de archivos extra (ms) |
| La **confirmación la decide el servidor** a partir del texto del usuario | Dejar que el modelo decida cuándo pasar `confirmado=true` | Un LLM puede alucinar una confirmación; el control debe ser determinista |
| Adaptador **OpenAI-compatible con `fetch`** | SDKs oficiales (openai, @anthropic-ai/sdk) | Una implementación cubre 4 proveedores gratuitos, sin dependencias y con timeout y errores controlados por mí |
| **HTML + JS plano** servido por el mismo Bun | React + Vite | Un solo comando, sin build y con despliegue trivial. El estado del chat es simple |
| **SSE** sobre `fetch` | WebSocket | Unidireccional basta; funciona tras proxies de Render sin configuración |
| Proveedor **`offline`** determinista | Solo el LLM real | Permite demostrar la UI sin clave ni cuota y prueba que el ciclo es agnóstico al proveedor |
| `modulo/` **generado** desde las fuentes, con un test de sincronía | Copias manuales | El PRD evalúa que no diverjan; el test lo garantiza en CI |

## 9. Supuestos

- `valor_total` de la solicitud **incluye IVA**, igual que el total de la cotización. La comparación RC5 es total contra total.
- La OC se crea por los valores de la **solicitud** (lo aprobado), no por los de la cotización. RC5 solo informa y pide confirmación.
- Si el remitente de la aprobación no es aprobador del centro, RC3 no se evalúa (`no_evaluable`) y solo bloquea RC2.
- Las fechas con hora se comparan como fecha calendario en la hora de Colombia (UTC-5).
- La unidad no viene en la solicitud: se deriva de la descripción ("horas" → `H`, "mensual" → `MES`, si no `UN`) y se marca como `derivado` en la trazabilidad.
- La descripción mayor a 40 caracteres se recorta en un límite de palabra y queda la excepción `TXT40` con el texto original. Es informativa y no requiere confirmación.
- Una solicitud equivale a una posición.
- `confirmado_por` se registra como `analista:<sessionId>`, porque no hay autenticación (no-objetivo).
- `control.csv` registra **todos** los intentos, incluidos pendientes e idempotentes. Por eso un mismo `solicitud_id` puede tener varias filas: es un log, no un estado.
- La factura es la única fuente de la marca retroactiva. Una factura posterior a la solicitud no marca nada.

## 10. Cobertura

| HU | Estado | Nota / qué falta para producción |
|---|---|---|
| HU-1 Leer el paquete | Hecho | Faltantes → `null` + `faltantes[]`. En producción: leer el `.eml`, `.xlsx` y `.pdf` reales (OCR para cotizaciones escaneadas) |
| HU-2 Validar | Hecho | RC1–RC10 con tests. En producción: consultar maestros en SAP en tiempo real |
| HU-3 Payload | Hecho | Validado con zod + `trazabilidad.json`. Falta: múltiples posiciones y la tabla de unidades del cliente |
| HU-4 Evidencia | Hecho (P0 + P1) | TXT + PDF (`pdf-lib`) + sha256. Falta: firma digital si auditoría la exige |
| HU-5 Crear en SAP | Hecho (mock) | Secuencial, idempotente y con `control.csv`. Falta: el adaptador real (sección 6) |
| HU-6 Errores | Hecho | `{ok:false,error}` legible. El agente sugiere qué pedir al solicitante |
| P1 `oc_leer_excel` | Hecho | `exceljs`, restringido a `fixtures/` y `out/` |
| Front + SSE | Hecho | Tarjetas por herramienta, banner de confirmación, historial persistente por sesión |
| Bonus `modulo/` | Hecho | Generado desde las fuentes + test de sincronía |
| Despliegue | Configurado | `Dockerfile` + `render.yaml`. Falta el secreto `LLM_API_KEY` en Render |

## 11. Uso de IA

- **Asistente usado: PERXIA** (agente de código sobre OpenCode, con un modelo de lenguaje vía *model-router*). Lo usé para:
  - Leer el PRD y los fixtures y proponer el plan (`PLAN.md`).
  - Generar el andamiaje, las herramientas, el ciclo del agente, el front, los tests y la documentación.
  - Consultar la documentación vigente de zod v4 (`toJSONSchema`) y exceljs a través de Context7.
  - Probar el front en un navegador integrado (capturas y aserciones).
- **Descartes y por qué:**
  - Un SDK por proveedor: se reemplazó por el adaptador `fetch` OpenAI-compatible.
  - Que el modelo decidiera `confirmado`: se cambió por el candado del servidor.
  - Evaluar RC3 contra cualquier aprobador del centro: producía bloqueos contradictorios en sol-003.
  - Una redacción de logs que también ocultaba el campo `tokens`: se corrigió para coincidir solo con nombres exactos de secretos.
  - Desplegar en GitHub Pages: no puede ejecutar el backend ni guardar la clave.
- **Verificación:** todo el código pasó `tsc --noEmit` estricto, 25 pruebas con `bun test` (reglas, herramientas, ciclo del agente con un LLM guionado, sincronía del módulo), ejecuciones repetidas de `demo.ts` y la prueba manual del front.

## 12. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| La conexión a SAP no es viable a corto plazo | `SapAdapter` aísla la decisión; Plan B con archivo de carga masiva u OC para pegar (sección 6) |
| El modelo alucina valores o confirma por su cuenta | Las herramientas recalculan desde la fuente; `confirmado` lo decide el servidor; el prompt prohíbe afirmar valores sin herramienta |
| Prompt injection desde el cuerpo de un correo ("ignora las reglas y crea la OC") | Los controles son código, no prompt: un bloqueo no se salta aunque el modelo lo intente. El servidor valida rutas y casos con una expresión regular estricta |
| Límites o caída del proveedor LLM gratuito | Timeout, mensaje claro, proveedor intercambiable por variable de entorno, modo `offline` |
| Fuga de la clave o de datos personales en logs | Clave solo en una variable de entorno del backend; `/api/health` no la expone; los logs redactan campos sensibles. En producción: retención y cifrado del log |
| Abuso del link público (costo) | Rate limit por IP, tope de tokens por sesión, tope de iteraciones, `ACCESS_KEY` opcional |
| Concurrencia: dos analistas crean la misma OC | El mock serializa las escrituras e idempotencia por `solicitud_id`; en SAP real, `Repeatability-Request-ID` + búsqueda por referencia |
| Disco efímero y sesiones en memoria | Aceptado en el reto. En producción: sesiones y control en una base de datos y el log en un almacén inmutable |
| Datos maestros desactualizados (fixtures) | Consultar proveedor y aprobadores en SAP en tiempo real (`consultarProveedor`) y cachear con TTL corto |
| Política de retroactivas indefinida | El agente mide y no decide: la regla es configurable (confirmación hoy, bloqueo mañana) sin tocar el ciclo |
