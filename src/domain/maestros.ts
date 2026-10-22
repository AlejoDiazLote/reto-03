import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { fixturesDir } from "./paths.ts"
import {
  CentroCostoSchema,
  CondicionPagoSchema,
  IndicadorIvaSchema,
  ProveedorSchema,
  type Maestros,
  type Proveedor,
} from "./types.ts"
import { normalizarNit, normalizarNombre } from "./parse.ts"

const cache = new Map<string, Maestros>()

async function leer<T>(ruta: string, schema: z.ZodType<T>): Promise<T> {
  const texto = await readFile(ruta, "utf8")
  return schema.parse(JSON.parse(texto))
}

export async function cargarMaestros(root: string): Promise<Maestros> {
  const previo = cache.get(root)
  if (previo) return previo
  const dir = join(fixturesDir(root), "maestros")
  const maestros: Maestros = {
    proveedores: await leer(join(dir, "proveedores.json"), z.array(ProveedorSchema)),
    centros: await leer(join(dir, "centros-costo.json"), z.array(CentroCostoSchema)),
    iva: await leer(join(dir, "indicadores-iva.json"), z.array(IndicadorIvaSchema)),
    pagos: await leer(join(dir, "condiciones-pago.json"), z.array(CondicionPagoSchema)),
  }
  cache.set(root, maestros)
  return maestros
}

export type BusquedaProveedor = { proveedor: Proveedor; criterio: "nit" | "nombre" } | null

export function buscarProveedor(maestros: Maestros, nit: string | undefined, nombre: string): BusquedaProveedor {
  const nitNorm = normalizarNit(nit)
  if (nitNorm) {
    const p = maestros.proveedores.find((x) => normalizarNit(x.nit) === nitNorm)
    return p ? { proveedor: p, criterio: "nit" } : null
  }
  const nombreNorm = normalizarNombre(nombre)
  const p = maestros.proveedores.find((x) => normalizarNombre(x.nombre) === nombreNorm)
  return p ? { proveedor: p, criterio: "nombre" } : null
}
