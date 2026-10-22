import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { generarModulo } from "../scripts/build-modulo.ts"
import * as moduloTools from "../modulo/tools/oc.ts"
import * as appTools from "../src/tools/oc.ts"

const root = join(import.meta.dir, "..")

test("modulo/ está sincronizado con la app (bun run build:modulo)", async () => {
  const { agent, skill } = await generarModulo()
  expect(await readFile(join(root, "modulo", "agent.md"), "utf8")).toBe(agent)
  expect(await readFile(join(root, "modulo", "skill", "ordenes-compra", "SKILL.md"), "utf8")).toBe(skill)
})

test("modulo/tools reexporta las mismas herramientas", () => {
  expect(moduloTools.crear).toBe(appTools.crear)
  expect(moduloTools.validar).toBe(appTools.validar)
})
