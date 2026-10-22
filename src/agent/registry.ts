import { z } from "zod"
import type { DefinicionHerramienta } from "../llm/adapter.ts"
import * as oc from "../tools/oc.ts"
import type { ToolContext } from "../tools/oc.ts"

type ArgsShape = Record<string, z.ZodType>

export type Herramienta = {
  description: string
  args: ArgsShape
  execute(args: never, ctx: ToolContext): Promise<string>
}

export type HerramientaRegistrada = {
  name: string
  schema: z.ZodObject<ArgsShape>
  definicion: DefinicionHerramienta
  ejecutar(args: unknown, ctx: ToolContext): Promise<string>
}

const MODULOS: Record<string, Record<string, unknown>> = { oc }

function esHerramienta(valor: unknown): valor is Herramienta {
  if (!valor || typeof valor !== "object") return false
  const v = valor as Record<string, unknown>
  return typeof v.description === "string" && typeof v.execute === "function" && typeof v.args === "object" && v.args !== null
}

function parametros(schema: z.ZodObject<ArgsShape>): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>
  delete json.$schema
  return json
}

export function registrarHerramientas(modulos: Record<string, Record<string, unknown>> = MODULOS): Map<string, HerramientaRegistrada> {
  const mapa = new Map<string, HerramientaRegistrada>()
  for (const [archivo, exportaciones] of Object.entries(modulos)) {
    for (const [nombreExport, valor] of Object.entries(exportaciones)) {
      if (!esHerramienta(valor)) continue
      const name = `${archivo}_${nombreExport}`
      const schema = z.object(valor.args).strict()
      const ejecutar = valor.execute as (args: unknown, ctx: ToolContext) => Promise<string>
      mapa.set(name, {
        name,
        schema,
        definicion: { name, description: valor.description, parameters: parametros(schema) },
        ejecutar: (args, ctx) => ejecutar(args, ctx),
      })
    }
  }
  return mapa
}

export function formatearErrorZod(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ")
}
