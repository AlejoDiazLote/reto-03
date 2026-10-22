import { join, resolve, sep } from "node:path"

export const CASO_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/

export function fixturesDir(root: string): string {
  return join(root, "fixtures", "reto-03")
}

export function casoDir(root: string, caso: string): string {
  if (!CASO_REGEX.test(caso)) throw new Error(`Nombre de caso inválido: "${caso}". Usa solo minúsculas, números y guiones (ej. sol-001).`)
  return join(fixturesDir(root), "solicitudes", caso)
}

export function outDir(root: string): string {
  return join(root, "out")
}

export function outCasoDir(root: string, caso: string): string {
  if (!CASO_REGEX.test(caso)) throw new Error(`Nombre de caso inválido: "${caso}"`)
  return join(outDir(root), caso)
}

export function dentroDe(root: string, ruta: string, permitidas: string[]): string {
  const absoluta = resolve(root, ruta)
  const ok = permitidas.some((p) => {
    const base = resolve(root, p)
    return absoluta === base || absoluta.startsWith(base + sep)
  })
  if (!ok) throw new Error(`Ruta fuera de las carpetas permitidas (${permitidas.join(", ")}): ${ruta}`)
  return absoluta
}
