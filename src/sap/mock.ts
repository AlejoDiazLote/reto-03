import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { cargarMaestros } from "../domain/maestros.ts"
import { normalizarNit } from "../domain/parse.ts"
import { outDir } from "../domain/paths.ts"
import type { OrdenCompra } from "../domain/types.ts"
import type { SapAdapter } from "./adapter.ts"

export const PRIMER_NUMERO_OC = 4500000001

type Registro = { numero_oc: string; fecha: string; orden: OrdenCompra }

export class SapMock implements SapAdapter {
  private cola: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly root: string,
    private readonly ahora: () => Date = () => new Date(),
  ) {}

  private get archivo(): string {
    return join(outDir(this.root), "sap", "ordenes.jsonl")
  }

  private async leer(): Promise<Registro[]> {
    try {
      const texto = await readFile(this.archivo, "utf8")
      return texto
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Registro)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
      throw e
    }
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const m = await cargarMaestros(this.root)
    const objetivo = normalizarNit(nit)
    const p = m.proveedores.find((x) => normalizarNit(x.nit) === objetivo)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const r = (await this.leer()).find((x) => x.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const tarea = this.cola.then(() => this.crearSerializado(orden))
    this.cola = tarea.catch(() => undefined)
    return tarea
  }

  private async crearSerializado(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const registros = await this.leer()
    const existente = registros.find((x) => x.orden.referencia.solicitud_id === orden.referencia.solicitud_id)
    if (existente) return { numero_oc: existente.numero_oc, fecha: existente.fecha }
    const numero_oc = String(PRIMER_NUMERO_OC + registros.length)
    const fecha = this.ahora().toISOString()
    await mkdir(join(outDir(this.root), "sap"), { recursive: true })
    await appendFile(this.archivo, `${JSON.stringify({ numero_oc, fecha, orden } satisfies Registro)}\n`, "utf8")
    return { numero_oc, fecha }
  }
}
