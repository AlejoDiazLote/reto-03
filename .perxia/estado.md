# Estado · Reto 03 Agente OC SAP

**Última etapa:** implementación completa del plan (`PLAN.md`), verificada localmente.

## Hecho
- Herramientas `oc_*` + dominio RC1–RC10, SAP mock, `control.csv` y `log.jsonl`.
- Evidencia de aprobación en TXT y PDF.
- `demo.ts` con salida determinista.
- Ciclo del agente con tope de iteraciones y tokens, confirmación forzada por el servidor y SSE.
- Adaptadores LLM: OpenAI-compatible (Gemini por defecto) y `offline`.
- Front HTML + JS con tarjetas por herramienta y banner de confirmación (probado en el navegador).
- `modulo/` generado desde las fuentes.
- 25 tests y `tsc` estricto en verde.
- Documentación: README, SOLUCION (12 secciones), Dockerfile y `render.yaml`.

## Decisiones clave
- Las herramientas recalculan desde disco: el modelo no puede alterar montos.
- `confirmado=true` solo pasa si el último mensaje del usuario es afirmativo y existe un pendiente para ese caso.

## Repositorio
https://github.com/AlejoDiazLote/reto-03 (público, rama main)

## Pendiente
1. El usuario crea la clave gratuita de Gemini en Google AI Studio y el Blueprint en Render con el secreto `LLM_API_KEY`.
2. Con la URL de Render: probar health + sol-004 con el LLM real, ajustar el prompt si hace falta y actualizar el link en el README.
