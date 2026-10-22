import type { DefinicionHerramienta, LlmAdapter, Mensaje, RespuestaLlm, ToolCall } from "./adapter.ts"

type Json = Record<string, unknown>

const FLUJO = ["oc_leer_paquete", "oc_validar", "oc_construir_payload", "oc_generar_evidencia", "oc_crear"] as const

const cop = (n: unknown): string => `COP ${Number(n).toLocaleString("es-CO")}`

function parse(texto: string): Json {
  try {
    return JSON.parse(texto) as Json
  } catch {
    return {}
  }
}

function turnoActual(mensajes: Mensaje[]): { usuario: string; herramientas: Array<{ name: string; args: Json; resultado: Json }> } {
  let i = mensajes.length - 1
  while (i >= 0 && mensajes[i]?.role !== "user") i--
  const usuarioMsg = mensajes[i]
  const usuario = usuarioMsg?.role === "user" ? usuarioMsg.content : ""
  const herramientas: Array<{ name: string; args: Json; resultado: Json }> = []
  const args = new Map<string, Json>()
  for (const m of mensajes.slice(i + 1)) {
    if (m.role === "assistant") for (const t of m.tool_calls ?? []) args.set(t.id, parse(t.arguments))
    if (m.role === "tool") herramientas.push({ name: m.name, args: args.get(m.tool_call_id) ?? {}, resultado: parse(m.content) })
  }
  return { usuario, herramientas }
}

function tablaOc(payload: Json, total: unknown): string {
  const o = (payload.orden ?? {}) as Json
  const p = ((o.posiciones as Json[] | undefined) ?? [])[0] ?? {}
  const prov = (o.proveedor ?? {}) as Json
  const apr = (o.aprobador ?? {}) as Json
  return [
    "| Campo | Valor |",
    "|---|---|",
    `| Proveedor | ${String(prov.codigo_sap)} · ${String(prov.nombre)} |`,
    `| Descripción | ${String(p.descripcion)} |`,
    `| Cantidad | ${String(p.cantidad)} ${String(p.unidad)} |`,
    `| Precio unitario | ${cop(p.precio_unitario)} |`,
    `| Valor total | ${cop(total)} |`,
    `| Centro de costo / subárea | ${String(p.centro_costo)} / ${String(p.subarea)} |`,
    `| IVA | ${String(p.indicador_iva)} |`,
    `| Condición de pago | ${String(o.condiciones_pago)} |`,
    `| Aprobador | ${String(apr.email)} |`,
  ].join("\n")
}

function redactar(caso: string, h: Array<{ name: string; resultado: Json }>, soloMostrar: boolean): string {
  const de = (n: string): Json | undefined => [...h].reverse().find((x) => x.name === n)?.resultado
  const lectura = de("oc_leer_paquete")
  if (lectura && lectura.ok !== true) return `**No pude leer ${caso}.** ${String(lectura.error)}`
  const v = (de("oc_validar")?.data ?? {}) as Json
  const bloqueos = (v.bloqueos as Json[] | undefined) ?? []
  const confirmaciones = (v.confirmaciones as Json[] | undefined) ?? []
  const reglasOk = ((v.reglas as Json[] | undefined) ?? []).filter((r) => r.estado === "ok").map((r) => String(r.codigo))
  if (bloqueos.length > 0) {
    return [
      `**Bloqueada** · ${caso}: la OC no se crea.`,
      "",
      ...bloqueos.map((b) => `- **${String(b.codigo)}** ${String(b.detalle)} → *${String(b.accion)}*`),
      "",
      `Validaciones que pasaron: ${reglasOk.join(", ") || "ninguna"}.`,
    ].join("\n")
  }
  const payload = (de("oc_construir_payload")?.data ?? {}) as Json
  const crear = de("oc_crear")
  const derivados = Object.values((v.derivados ?? {}) as Record<string, Json>).map((d) => `- Derivado: ${String(d.detalle)}`)
  const evidencia = (de("oc_generar_evidencia")?.data ?? {}) as Json
  const cuerpo = [tablaOc(payload, payload.valor_total), "", `Validaciones que pasaron: ${reglasOk.join(", ")}.`, ...derivados]
  if (crear?.ok === true) {
    const d = crear.data as Json
    const estado = d.idempotente ? `**Ya existía** · la OC **${String(d.numero_oc)}** ya estaba creada para ${caso}.` : `**OC creada** · número **${String(d.numero_oc)}**.`
    return [estado, "", ...cuerpo, "", `Evidencia: \`${String(evidencia.ruta_pdf ?? `out/${caso}/aprobacion.pdf`)}\` · payload: \`out/${caso}/payload.json\`${v.retroactiva ? "\n\n**Atención:** la OC quedó marcada como **retroactiva** en el log de control." : ""}`].join("\n")
  }
  if (crear && crear.ok !== true && crear.resultado !== "pendiente_confirmacion") return `No pude crear la OC de ${caso}: ${String(crear.error)}`
  return [
    "**Requiere tu confirmación**",
    "",
    ...cuerpo,
    "",
    ...confirmaciones.map((c) => `- **${String(c.codigo)}** ${String(c.detalle)}`),
    "",
    soloMostrar && !crear ? `¿Confirmas que cree la OC de ${caso}?` : `¿Confirmas que cree la OC de ${caso} con estas excepciones?`,
  ].join("\n")
}

export class OfflineAdapter implements LlmAdapter {
  readonly provider = "offline"
  readonly model = "guion-determinista"
  private n = 0

  async enviar(mensajes: Mensaje[], _herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm> {
    const { usuario, herramientas } = turnoActual(mensajes)
    const usage = { input: 0, output: 0 }
    const confirma = /\[Nota del sistema: el usuario confirmó explícitamente las excepciones pendientes del caso (sol-[0-9]+)/.exec(usuario)?.[1]
    const casoPrevio = [...mensajes].reverse().map((m) => (m.role === "user" ? /\bsol-\d{3,}\b/i.exec(m.content)?.[0] : undefined)).find(Boolean)
    const casos = [...new Set((usuario.split("[Nota")[0] ?? "").toLowerCase().match(/\bsol-\d{3,}\b/g) ?? [])]
    const llamar = (name: string, caso: string, extra: Json = {}): RespuestaLlm => {
      const call: ToolCall = { id: `off-${++this.n}`, name, arguments: JSON.stringify({ caso, ...extra }) }
      return { content: null, toolCalls: [call], usage }
    }

    if (confirma) {
      const siguiente = (["oc_validar", "oc_construir_payload", "oc_generar_evidencia", "oc_crear"] as const).find((n) => !herramientas.some((x) => x.name === n))
      if (siguiente) return llamar(siguiente, confirma, siguiente === "oc_crear" ? { confirmado: true } : {})
      return { content: redactar(confirma, herramientas, false), toolCalls: [], usage }
    }
    if (casos.length === 0) {
      const texto = casoPrevio && /\b(no|cancel)/i.test(usuario)
        ? `Entendido, no creo la OC de ${casoPrevio}. Queda pendiente hasta que la confirmes.`
        : "Indícame qué solicitud procesar, por ejemplo **procesa sol-004**. (Modo offline: sin modelo de lenguaje, flujo determinista.)"
      return { content: texto, toolCalls: [], usage }
    }
    const soloMostrar = /no la crees|sin crear|hasta que (yo )?(lo )?confirme/i.test(usuario)
    const partes: string[] = []
    for (const caso of casos) {
      const propias = herramientas.filter((x) => x.args.caso === caso)
      const ultima = propias.at(-1)
      const bloqueada = propias.some((x) => x.name === "oc_validar" && (x.resultado.data as Json | undefined)?.apta === false)
      const fallo = ultima && ultima.resultado.ok !== true && ultima.resultado.resultado !== "pendiente_confirmacion"
      const terminado = bloqueada || fallo || propias.some((x) => x.name === "oc_crear")
      if (!terminado) {
        const siguiente = FLUJO.find((n) => !propias.some((x) => x.name === n))
        if (siguiente && !(soloMostrar && siguiente === "oc_crear")) return llamar(siguiente, caso)
      }
      partes.push(redactar(caso, propias, soloMostrar))
    }
    return { content: partes.join("\n\n---\n\n"), toolCalls: [], usage }
  }
}
