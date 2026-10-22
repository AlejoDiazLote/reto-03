import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const root = join(import.meta.dir, "..")

export async function generarModulo(): Promise<{ agent: string; skill: string }> {
  const prompt = await readFile(join(root, "agent", "prompt.md"), "utf8")
  const conocimiento = await readFile(join(root, "src", "knowledge", "ordenes-compra.md"), "utf8")
  const agent = [
    "---",
    "description: Prepara, valida y crea órdenes de compra en SAP a partir del paquete de solicitud (solicitud, cotización, aprobación), con confirmación humana para las excepciones.",
    "mode: primary",
    "permission:",
    "  edit: deny",
    "  bash: deny",
    "---",
    "",
    prompt.trim(),
    "",
  ].join("\n")
  const skill = [
    "---",
    "name: ordenes-compra",
    "description: Conocimiento del proceso de órdenes de compra de Periferia (maestros, reglas de control RC1–RC10, OC retroactivas, payload SAP). Úsalo al procesar solicitudes de compra con las herramientas oc_*.",
    "---",
    "",
    conocimiento.trim(),
    "",
  ].join("\n")
  return { agent, skill }
}

if (import.meta.main) {
  const { agent, skill } = await generarModulo()
  await mkdir(join(root, "modulo", "skill", "ordenes-compra"), { recursive: true })
  await writeFile(join(root, "modulo", "agent.md"), agent, "utf8")
  await writeFile(join(root, "modulo", "skill", "ordenes-compra", "SKILL.md"), skill, "utf8")
  console.log("modulo/agent.md y modulo/skill/ordenes-compra/SKILL.md regenerados")
}
