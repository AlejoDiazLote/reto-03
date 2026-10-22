import { contenidoAprobacion, sha256 } from "./evidence.ts"
import { buscarProveedor } from "./maestros.ts"
import { OrdenCompraSchema, type AprobacionRaw, type Maestros, type OrdenCompra, type Paquete, type Validacion } from "./types.ts"

export const LIMITE_TEXTO_BREVE = 40

export type Fuente = "solicitud" | "cotizacion" | "correo" | "aprobacion" | "derivado" | "constante" | `maestro.${string}`
export type Trazabilidad = Record<string, { valor: string | number | null; fuente: Fuente; detalle?: string }>

export function derivarUnidad(descripcion: string): { unidad: "UN" | "H" | "MES"; detalle: string } {
  const d = descripcion.toLowerCase()
  if (/\bhoras?\b/.test(d)) return { unidad: "H", detalle: 'La descripción menciona "horas"' }
  if (/\b(mensual|mensualidad|por mes)\b/.test(d)) return { unidad: "MES", detalle: "La descripción indica cobro mensual" }
  return { unidad: "UN", detalle: "Unidad por defecto" }
}

export function textoBreve(descripcion: string): { texto: string; recortado: boolean } {
  if (descripcion.length <= LIMITE_TEXTO_BREVE) return { texto: descripcion, recortado: false }
  const corte = descripcion.slice(0, LIMITE_TEXTO_BREVE)
  const espacio = corte.lastIndexOf(" ")
  const texto = (espacio > 25 ? corte.slice(0, espacio) : corte).replace(/[\s,;:.-]+$/, "")
  return { texto, recortado: true }
}

export type PayloadConstruido = { orden: OrdenCompra; trazabilidad: Trazabilidad }

export function construirOrden(p: Paquete, v: Validacion, m: Maestros, aprobacionRaw: AprobacionRaw): PayloadConstruido {
  if (!v.apta) throw new Error(`La solicitud tiene bloqueos (${v.bloqueos.map((b) => b.codigo).join(", ")}); no se construye el payload.`)
  const s = p.solicitud
  const prov = buscarProveedor(m, s.proveedor_nit, s.proveedor_nombre)?.proveedor
  if (!prov) throw new Error("Proveedor no encontrado al construir el payload.")
  if (!p.aprobacion) throw new Error("Sin aprobación no se construye el payload.")

  const iva = s.indicador_iva ?? v.derivados.indicador_iva?.valor
  const pago = s.condiciones_pago ?? v.derivados.condiciones_pago?.valor
  if (!iva || !pago) throw new Error("Falta indicador de IVA o condición de pago y no se pudo derivar.")

  const unidad = derivarUnidad(s.descripcion)
  const breve = textoBreve(s.descripcion)
  const hash = sha256(contenidoAprobacion(aprobacionRaw))

  const excepciones: OrdenCompra["excepciones"] = v.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: null }))
  if (breve.recortado) {
    excepciones.push({ codigo: "TXT40", detalle: `Descripción recortada a ${LIMITE_TEXTO_BREVE} caracteres. Original: "${s.descripcion}"`, confirmado_por: null })
  }
  for (const [campo, d] of Object.entries(v.derivados)) {
    if (campo === "condiciones_pago") excepciones.push({ codigo: "RC7", detalle: d.detalle, confirmado_por: null })
  }

  const orden = OrdenCompraSchema.parse({
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: prov.codigo_sap, nit: prov.nit, nombre: prov.nombre },
    moneda: s.moneda,
    condiciones_pago: pago,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: p.aprobacion.fecha, evidencia_sha256: hash },
    posiciones: [
      {
        numero: 10,
        descripcion: breve.texto,
        cantidad: s.cantidad,
        unidad: unidad.unidad,
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: iva,
      },
    ],
    excepciones,
  })

  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": { valor: s.solicitud_id, fuente: "solicitud" },
    "referencia.correo_id": { valor: p.correo.id, fuente: "correo" },
    "referencia.cotizacion_ref": { valor: p.cotizacion?.referencia ?? null, fuente: "cotizacion" },
    sociedad: { valor: "1000", fuente: "constante", detalle: "Sociedad fija definida en el PRD" },
    organizacion_compras: { valor: "1000", fuente: "constante", detalle: "Organización de compras fija definida en el PRD" },
    "proveedor.codigo_sap": { valor: prov.codigo_sap, fuente: "maestro.proveedores" },
    "proveedor.nit": { valor: prov.nit, fuente: "maestro.proveedores" },
    "proveedor.nombre": { valor: prov.nombre, fuente: "maestro.proveedores" },
    moneda: { valor: s.moneda, fuente: "solicitud" },
    condiciones_pago: s.condiciones_pago
      ? { valor: pago, fuente: "solicitud" }
      : { valor: pago, fuente: "maestro.proveedores", detalle: v.derivados.condiciones_pago?.detalle ?? "derivado" },
    "aprobador.email": { valor: p.aprobacion.de, fuente: "aprobacion" },
    "aprobador.fecha_aprobacion": { valor: p.aprobacion.fecha, fuente: "aprobacion" },
    "aprobador.evidencia_sha256": { valor: hash, fuente: "derivado", detalle: "SHA-256 del correo de aprobación (encabezados + cuerpo)" },
    "posiciones[0].numero": { valor: 10, fuente: "constante", detalle: "Primera posición SAP" },
    "posiciones[0].descripcion": breve.recortado
      ? { valor: breve.texto, fuente: "derivado", detalle: `Recorte a ${LIMITE_TEXTO_BREVE} caracteres de solicitud.descripcion` }
      : { valor: breve.texto, fuente: "solicitud" },
    "posiciones[0].cantidad": { valor: s.cantidad, fuente: "solicitud" },
    "posiciones[0].unidad": { valor: unidad.unidad, fuente: "derivado", detalle: unidad.detalle },
    "posiciones[0].precio_unitario": { valor: s.valor_unitario, fuente: "solicitud" },
    "posiciones[0].centro_costo": { valor: s.centro_costo, fuente: "solicitud" },
    "posiciones[0].subarea": { valor: s.subarea, fuente: "solicitud" },
    "posiciones[0].indicador_iva": s.indicador_iva
      ? { valor: iva, fuente: "solicitud" }
      : { valor: iva, fuente: "maestro.proveedores", detalle: v.derivados.indicador_iva?.detalle ?? "derivado" },
  }
  return { orden, trazabilidad }
}
