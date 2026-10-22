import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { cargarMaestros } from "../src/domain/maestros.ts"
import { leerPaquete } from "../src/domain/paquete.ts"
import { normalizarNit, parseMonto } from "../src/domain/parse.ts"
import { derivarUnidad, textoBreve } from "../src/domain/payload.ts"
import { validarPaquete } from "../src/domain/rules.ts"
import type { Paquete } from "../src/domain/types.ts"

const root = join(import.meta.dir, "..")

async function paquete(caso: string): Promise<Paquete> {
  const r = await leerPaquete(root, caso)
  if (!r.ok) throw new Error(r.error)
  return r.data
}

async function validar(p: Paquete) {
  return validarPaquete(p, await cargarMaestros(root))
}

const codigos = (xs: Array<{ codigo: string }>) => xs.map((x) => x.codigo)

describe("parseo", () => {
  test("montos con separador de miles", () => {
    expect(parseMonto("COP 11.400.000")).toBe(11400000)
    expect(parseMonto("1.234,5")).toBe(1234.5)
  })
  test("NIT sin dígito de verificación", () => {
    expect(normalizarNit("900.555.111-2")).toBe("900555111")
    expect(normalizarNit(undefined)).toBeNull()
  })
  test("unidad y texto breve", () => {
    expect(derivarUnidad("Bolsa de 100 horas").unidad).toBe("H")
    expect(derivarUnidad("Licencias").unidad).toBe("UN")
    expect(textoBreve("x".repeat(50)).texto.length).toBeLessThanOrEqual(40)
  })
})

describe("casos de los fixtures", () => {
  test("sol-001 apta sin confirmaciones", async () => {
    const v = await validar(await paquete("sol-001"))
    expect(v.apta).toBe(true)
    expect(v.confirmaciones).toHaveLength(0)
  })
  test("sol-002 bloqueo RC1", async () => {
    const v = await validar(await paquete("sol-002"))
    expect(v.apta).toBe(false)
    expect(codigos(v.bloqueos)).toEqual(["RC1"])
  })
  test("sol-003 bloqueo RC2 (aprobador de otro centro)", async () => {
    const v = await validar(await paquete("sol-003"))
    expect(v.apta).toBe(false)
    expect(codigos(v.bloqueos)).toContain("RC2")
  })
  test("sol-004 confirmación RC5 con ambos valores", async () => {
    const v = await validar(await paquete("sol-004"))
    expect(v.apta).toBe(true)
    expect(v.confirmaciones[0]?.valores).toMatchObject({ valor_solicitud: 25000000, valor_cotizacion: 26500000 })
  })
  test("sol-005 retroactiva RC8", async () => {
    const v = await validar(await paquete("sol-005"))
    expect(v.retroactiva).toBe(true)
    expect(codigos(v.confirmaciones)).toEqual(["RC8"])
  })
  test("sol-006 IVA y pago derivados", async () => {
    const v = await validar(await paquete("sol-006"))
    expect(codigos(v.confirmaciones)).toEqual(["RC6"])
    expect(v.derivados.indicador_iva?.valor).toBe("C1")
    expect(v.derivados.condiciones_pago?.valor).toBe("Z030")
  })
})

describe("reglas sobre variaciones", () => {
  test("RC3 tope excedido", async () => {
    const p = await paquete("sol-001")
    p.solicitud = { ...p.solicitud, cantidad: 600, valor_total: 57000000 }
    expect(codigos((await validar(p)).bloqueos)).toEqual(["RC3"])
  })
  test("RC4 subárea ajena", async () => {
    const p = await paquete("sol-001")
    p.solicitud = { ...p.solicitud, subarea: "Marketing" }
    expect(codigos((await validar(p)).bloqueos)).toEqual(["RC4"])
  })
  test("RC2 sin la palabra Aprobado", async () => {
    const p = await paquete("sol-001")
    p.aprobacion = p.aprobacion && { ...p.aprobacion, aprobado: false }
    expect(codigos((await validar(p)).bloqueos)).toContain("RC2")
  })
  test("RC5 sin cotización pide confirmación", async () => {
    const p = await paquete("sol-001")
    p.cotizacion = null
    expect(codigos((await validar(p)).confirmaciones)).toEqual(["RC5"])
  })
  test("RC9 aprobación anterior a la solicitud", async () => {
    const p = await paquete("sol-001")
    p.aprobacion = p.aprobacion && { ...p.aprobacion, fecha: "2026-08-19T10:00:00-05:00" }
    expect(codigos((await validar(p)).confirmaciones)).toEqual(["RC9"])
  })
  test("RC10 aritmética", async () => {
    const p = await paquete("sol-001")
    p.solicitud = { ...p.solicitud, valor_total: 11400005 }
    expect(codigos((await validar(p)).bloqueos)).toContain("RC10")
  })
  test("RC1 por nombre normalizado y proveedor inactivo", async () => {
    const p = await paquete("sol-001")
    const { proveedor_nit: _omit, ...resto } = p.solicitud
    p.solicitud = { ...resto, proveedor_nombre: "tecnosuministros sas" }
    expect((await validar(p)).apta).toBe(true)
    p.solicitud = { ...p.solicitud, proveedor_nit: "901777888" }
    expect(codigos((await validar(p)).bloqueos)).toEqual(["RC1"])
  })
})
