type Json = Record<string, unknown>

const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {})
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : [])
const codigos = (v: unknown): string => arr(v).map((x) => String(x.codigo)).join(", ")

export function resumirResultado(nombre: string, resultado: Json): string {
  if (resultado.ok !== true) {
    if (resultado.resultado === "pendiente_confirmacion") return `pendiente de confirmación: ${codigos(resultado.confirmaciones)}`
    return `error: ${String(resultado.error ?? "desconocido").slice(0, 160)}`
  }
  const d = obj(resultado.data)
  switch (nombre) {
    case "oc_leer_paquete": {
      const s = obj(d.solicitud)
      const faltan = Array.isArray(d.faltantes) && d.faltantes.length > 0 ? ` · faltan: ${d.faltantes.join(", ")}` : ""
      return `${String(s.solicitud_id)} · ${String(s.proveedor_nombre)} · ${String(s.moneda)} ${Number(s.valor_total).toLocaleString("es-CO")}${d.factura ? " · con factura" : ""}${faltan}`
    }
    case "oc_validar": {
      const b = arr(d.bloqueos).length
      const c = arr(d.confirmaciones).length
      return `apta: ${d.apta ? "sí" : "no"} · ${b} bloqueo(s)${b ? ` (${codigos(d.bloqueos)})` : ""} · ${c} confirmación(es)${c ? ` (${codigos(d.confirmaciones)})` : ""}${d.retroactiva ? " · RETROACTIVA" : ""}`
    }
    case "oc_construir_payload":
      return `payload válido · ${String(d.ruta_payload)}`
    case "oc_generar_evidencia":
      return `${String(d.ruta)} · sha256 ${String(d.sha256).slice(0, 12)}…`
    case "oc_crear":
      return d.idempotente ? `OC ${String(d.numero_oc)} ya existía (idempotente)` : `OC ${String(d.numero_oc)} creada`
    case "oc_leer_excel":
      return `${arr(d.filas).length} fila(s) de la hoja ${String(d.hoja)}`
    default:
      return "ok"
  }
}
