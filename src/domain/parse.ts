import type { Cotizacion, Factura } from "./types.ts"

export function normalizarNit(nit: string | null | undefined): string | null {
  if (!nit) return null
  const sinDv = nit.split("-")[0] ?? ""
  const digitos = sinDv.replace(/\D/g, "")
  return digitos.length > 0 ? digitos : null
}

export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(sas|sa|ltda|sca|eu)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function parseMonto(texto: string): number | null {
  const limpio = texto.replace(/[^\d.,]/g, "")
  if (!limpio) return null
  const sinMiles = limpio.replace(/\./g, "").replace(",", ".")
  const valor = Number(sinMiles)
  return Number.isFinite(valor) ? valor : null
}

function campo(texto: string, etiqueta: RegExp): string | null {
  const m = texto.match(etiqueta)
  return m?.[1]?.trim() ?? null
}

export function sumarDias(fechaIso: string, dias: number): string {
  const d = new Date(`${fechaIso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

export function fechaLocal(fecha: string): string {
  const m = fecha.match(/^(\d{4}-\d{2}-\d{2})/)
  if (m?.[1]) return m[1]
  const d = new Date(fecha)
  if (Number.isNaN(d.getTime())) return fecha
  return new Date(d.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10)
}

export function parseCotizacion(texto: string): Cotizacion {
  const totalMatch = texto.match(/^TOTAL[^:\n]*:\s*([A-Z]{3})?\s*([\d.,]+)/im)
  const total = totalMatch?.[2] ? parseMonto(totalMatch[2]) : null
  if (total === null) throw new Error("La cotización no tiene un TOTAL legible")
  const fecha = campo(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m)
  const diasValidez = campo(texto, /Validez[^:\n]*:\s*(\d+)\s*d[ií]as/i)
  return {
    referencia: campo(texto, /COTIZACI[ÓO]N\s+([A-Z0-9-]+)/i),
    proveedor: campo(texto, /^Proveedor:\s*(.+)$/m) ?? "",
    nit: normalizarNit(campo(texto, /^NIT:\s*([\d.\-]+)/m)),
    total,
    moneda: totalMatch?.[1] ?? "COP",
    validez_hasta: fecha && diasValidez ? sumarDias(fecha, Number(diasValidez)) : null,
    texto,
  }
}

export function parseFactura(texto: string): Factura {
  const numero = campo(texto, /FACTURA[^\n]*No\.?\s*([A-Z0-9-]+)/i)
  const fecha = campo(texto, /Fecha[^:\n]*:\s*(\d{4}-\d{2}-\d{2})/i)
  const totalMatch = texto.match(/^TOTAL:\s*([A-Z]{3})?\s*([\d.,]+)/im)
  const total = totalMatch?.[2] ? parseMonto(totalMatch[2]) : null
  if (!numero || !fecha || total === null) throw new Error("La factura no tiene número, fecha o total legibles")
  return { numero, fecha, total }
}

export function contieneAprobado(cuerpo: string): boolean {
  if (/\bno\s+(est[áa]\s+)?aprobad[oa]\b/i.test(cuerpo)) return false
  return /\baprobad[oa]\b/i.test(cuerpo)
}
