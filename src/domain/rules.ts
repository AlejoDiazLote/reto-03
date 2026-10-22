import { buscarProveedor } from "./maestros.ts"
import { fechaLocal } from "./parse.ts"
import type { Bloqueo, CentroCosto, Confirmacion, Derivado, Maestros, Paquete, Proveedor, Validacion } from "./types.ts"

export const TOLERANCIA_COTIZACION = 0.02
export const TOLERANCIA_ARITMETICA = 1

type Estado = Validacion["reglas"][number]["estado"]

class Acumulador {
  bloqueos: Bloqueo[] = []
  confirmaciones: Confirmacion[] = []
  derivados: Record<string, Derivado> = {}
  reglas: Validacion["reglas"] = []
  retroactiva = false

  regla(codigo: string, estado: Estado, detalle: string): void {
    this.reglas.push({ codigo, estado, detalle })
  }
  bloquear(codigo: string, detalle: string, accion: string): void {
    this.bloqueos.push({ codigo, detalle, accion })
    this.regla(codigo, "bloqueo", detalle)
  }
  confirmar(codigo: string, detalle: string, valores?: Record<string, string | number>): void {
    this.confirmaciones.push(valores ? { codigo, detalle, valores } : { codigo, detalle })
    this.regla(codigo, "confirmacion", detalle)
  }
}

const cop = (n: number): string => n.toLocaleString("es-CO", { maximumFractionDigits: 0 })

function rc1Proveedor(p: Paquete, m: Maestros, a: Acumulador): Proveedor | null {
  const s = p.solicitud
  const encontrado = buscarProveedor(m, s.proveedor_nit, s.proveedor_nombre)
  const id = s.proveedor_nit ? `NIT ${s.proveedor_nit}` : `nombre "${s.proveedor_nombre}"`
  if (!encontrado) {
    a.bloquear(
      "RC1",
      `El proveedor ${s.proveedor_nombre} (${id}) no existe en el maestro de proveedores.`,
      "Solicitar a datos maestros la creación del proveedor en SAP (RUT, certificación bancaria) o pedir al solicitante una cotización de un proveedor registrado.",
    )
    return null
  }
  if (!encontrado.proveedor.activo) {
    a.bloquear(
      "RC1",
      `El proveedor ${encontrado.proveedor.nombre} (código SAP ${encontrado.proveedor.codigo_sap}) está inactivo.`,
      "Solicitar a datos maestros la reactivación del proveedor o elegir un proveedor activo.",
    )
    return null
  }
  a.regla("RC1", "ok", `Proveedor ${encontrado.proveedor.nombre} encontrado por ${encontrado.criterio} (código SAP ${encontrado.proveedor.codigo_sap}), activo.`)
  return encontrado.proveedor
}

function rc4Subarea(p: Paquete, centro: CentroCosto | null, a: Acumulador): void {
  const s = p.solicitud
  if (!centro) {
    a.bloquear("RC4", `El centro de costo ${s.centro_costo} no existe en el maestro.`, "Pedir al solicitante el centro de costo correcto.")
    return
  }
  if (!centro.subareas.includes(s.subarea)) {
    a.bloquear(
      "RC4",
      `La subárea "${s.subarea}" no pertenece a ${centro.centro_costo} (válidas: ${centro.subareas.join(", ")}).`,
      "Pedir al solicitante que corrija la subárea o el centro de costo.",
    )
    return
  }
  a.regla("RC4", "ok", `Subárea "${s.subarea}" pertenece a ${centro.centro_costo}.`)
}

function rc2rc3Aprobacion(p: Paquete, centro: CentroCosto | null, a: Acumulador): void {
  const s = p.solicitud
  const apr = p.aprobacion
  const habilitados = centro ? centro.aprobadores.filter((x) => x.tope >= s.valor_total).map((x) => `${x.email} (tope ${cop(x.tope)})`) : []
  const sugerencia = habilitados.length > 0
    ? `Solicitar la aprobación a: ${habilitados.join(", ")}.`
    : `Ningún aprobador de ${s.centro_costo} tiene tope para ${cop(s.valor_total)}; escalar a la gerencia o dividir la compra con justificación.`

  if (!apr) {
    a.bloquear("RC2", "No hay correo de aprobación del líder.", `Pedir al solicitante el correo de aprobación. ${sugerencia}`)
    a.regla("RC3", "no_evaluable", "Sin aprobación no se puede verificar el tope.")
    return
  }
  if (!apr.aprobado) {
    a.bloquear("RC2", `El correo de ${apr.de} no contiene la palabra "Aprobado".`, `Pedir una aprobación explícita. ${sugerencia}`)
    a.regla("RC3", "no_evaluable", "La aprobación no es explícita.")
    return
  }
  const aprobador = centro?.aprobadores.find((x) => x.email.toLowerCase() === apr.de.toLowerCase())
  if (!aprobador) {
    a.bloquear(
      "RC2",
      `${apr.de} no está registrado como aprobador del centro de costo ${s.centro_costo}.`,
      sugerencia,
    )
    a.regla("RC3", "no_evaluable", `${apr.de} no es aprobador de ${s.centro_costo}; el tope no aplica.`)
    return
  }
  a.regla("RC2", "ok", `Aprobación explícita de ${apr.de}, aprobador de ${s.centro_costo}.`)
  if (s.valor_total > aprobador.tope) {
    a.bloquear(
      "RC3",
      `El valor ${cop(s.valor_total)} supera el tope de ${apr.de} (${cop(aprobador.tope)}) en ${s.centro_costo}.`,
      sugerencia,
    )
    return
  }
  a.regla("RC3", "ok", `Valor ${cop(s.valor_total)} dentro del tope de ${apr.de} (${cop(aprobador.tope)}).`)
}

function rc5Cotizacion(p: Paquete, a: Acumulador): void {
  const s = p.solicitud
  if (!p.cotizacion) {
    a.confirmar("RC5", "No hay cotización del proveedor: confirmar que se crea la OC sin cotización.", { valor_solicitud: s.valor_total })
    return
  }
  const dif = Math.abs(p.cotizacion.total - s.valor_total) / s.valor_total
  const pct = `${(dif * 100).toFixed(2)} %`
  if (dif > TOLERANCIA_COTIZACION) {
    a.confirmar(
      "RC5",
      `La cotización (${cop(p.cotizacion.total)}) difiere ${pct} de la solicitud (${cop(s.valor_total)}); tolerancia 2 %. La OC se crea por el valor de la solicitud, que es el aprobado.`,
      { valor_solicitud: s.valor_total, valor_cotizacion: p.cotizacion.total, diferencia_pct: Number((dif * 100).toFixed(2)) },
    )
    return
  }
  a.regla("RC5", "ok", `Cotización (${cop(p.cotizacion.total)}) coincide con la solicitud (diferencia ${pct}).`)
}

function rc6Iva(p: Paquete, m: Maestros, prov: Proveedor | null, a: Acumulador): void {
  const s = p.solicitud
  if (s.indicador_iva) {
    if (!m.iva.some((x) => x.codigo === s.indicador_iva)) {
      a.bloquear("RC6", `El indicador de IVA "${s.indicador_iva}" no existe en el maestro.`, `Usar uno de: ${m.iva.map((x) => x.codigo).join(", ")}.`)
      return
    }
    a.regla("RC6", "ok", `Indicador de IVA ${s.indicador_iva} informado en la solicitud.`)
    return
  }
  if (!prov) {
    a.regla("RC6", "no_evaluable", "IVA no informado y no hay proveedor válido para derivarlo.")
    return
  }
  const iva = m.iva.find((x) => x.codigo === prov.indicador_iva_default)
  const desc = iva ? `${iva.codigo} (${iva.descripcion})` : prov.indicador_iva_default
  a.derivados.indicador_iva = { valor: prov.indicador_iva_default, fuente: "maestro.proveedores", detalle: `IVA por defecto del proveedor ${prov.nombre}: ${desc}` }
  a.confirmar("RC6", `La solicitud no informa el indicador de IVA; se propone ${desc}, el default del proveedor.`, { indicador_iva_propuesto: prov.indicador_iva_default })
}

function rc7Pago(p: Paquete, m: Maestros, prov: Proveedor | null, a: Acumulador): void {
  const s = p.solicitud
  if (s.condiciones_pago) {
    if (!m.pagos.some((x) => x.codigo === s.condiciones_pago)) {
      a.bloquear("RC7", `La condición de pago "${s.condiciones_pago}" no existe en el maestro.`, `Usar una de: ${m.pagos.map((x) => x.codigo).join(", ")}.`)
      return
    }
    a.regla("RC7", "ok", `Condición de pago ${s.condiciones_pago} informada en la solicitud.`)
    return
  }
  if (!prov) {
    a.regla("RC7", "no_evaluable", "Condición de pago no informada y no hay proveedor válido para derivarla.")
    return
  }
  const cp = m.pagos.find((x) => x.codigo === prov.condiciones_pago_default)
  const desc = cp ? `${cp.codigo} (${cp.descripcion})` : prov.condiciones_pago_default
  a.derivados.condiciones_pago = { valor: prov.condiciones_pago_default, fuente: "maestro.proveedores", detalle: `Condición de pago por defecto del proveedor ${prov.nombre}: ${desc}` }
  a.regla("RC7", "derivado", `Condición de pago no informada; se toma ${desc} del proveedor.`)
}

function rc8Retroactiva(p: Paquete, a: Acumulador): void {
  const s = p.solicitud
  if (!p.factura) {
    a.regla("RC8", "ok", "No hay factura previa: la OC no es retroactiva.")
    return
  }
  const fFactura = fechaLocal(p.factura.fecha)
  if (fFactura < s.fecha_solicitud) {
    a.retroactiva = true
    a.confirmar(
      "RC8",
      `OC retroactiva: la factura ${p.factura.numero} (${fFactura}) es anterior a la solicitud (${s.fecha_solicitud}). Quedará marcada retroactiva en el log de control.`,
      { fecha_factura: fFactura, fecha_solicitud: s.fecha_solicitud, factura: p.factura.numero },
    )
    return
  }
  a.regla("RC8", "ok", `La factura ${p.factura.numero} (${fFactura}) no es anterior a la solicitud.`)
}

function rc9FechaAprobacion(p: Paquete, a: Acumulador): void {
  const s = p.solicitud
  if (!p.aprobacion) {
    a.regla("RC9", "no_evaluable", "Sin aprobación.")
    return
  }
  const fApr = fechaLocal(p.aprobacion.fecha)
  if (fApr < s.fecha_solicitud) {
    a.confirmar("RC9", `La aprobación (${fApr}) es anterior a la solicitud (${s.fecha_solicitud}).`, { fecha_aprobacion: fApr, fecha_solicitud: s.fecha_solicitud })
    return
  }
  a.regla("RC9", "ok", `Aprobación (${fApr}) posterior o igual a la solicitud (${s.fecha_solicitud}).`)
}

function rc10Aritmetica(p: Paquete, a: Acumulador): void {
  const s = p.solicitud
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > TOLERANCIA_ARITMETICA) {
    a.bloquear(
      "RC10",
      `cantidad × valor_unitario = ${cop(calculado)} no coincide con valor_total ${cop(s.valor_total)}.`,
      "Pedir al solicitante que corrija cantidad, valor unitario o valor total en el Excel.",
    )
    return
  }
  a.regla("RC10", "ok", `${s.cantidad} × ${cop(s.valor_unitario)} = ${cop(s.valor_total)}.`)
}

export function validarPaquete(p: Paquete, m: Maestros): Validacion {
  const a = new Acumulador()
  const centro = m.centros.find((c) => c.centro_costo === p.solicitud.centro_costo) ?? null
  const prov = rc1Proveedor(p, m, a)
  rc2rc3Aprobacion(p, centro, a)
  rc4Subarea(p, centro, a)
  rc5Cotizacion(p, a)
  rc6Iva(p, m, prov, a)
  rc7Pago(p, m, prov, a)
  rc8Retroactiva(p, a)
  rc9FechaAprobacion(p, a)
  rc10Aritmetica(p, a)
  return {
    apta: a.bloqueos.length === 0,
    bloqueos: a.bloqueos,
    confirmaciones: a.confirmaciones,
    derivados: a.derivados,
    retroactiva: a.retroactiva,
    reglas: a.reglas,
  }
}
