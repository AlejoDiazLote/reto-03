import { z } from "zod"

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string().min(1),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number().positive(),
  valor_unitario: z.number().nonnegative(),
  valor_total: z.number().positive(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha_solicitud debe ser YYYY-MM-DD"),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
})

export const AprobacionRawSchema = z.object({
  de: z.string(),
  para: z.string(),
  cc: z.array(z.string()).optional(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
})
export type AprobacionRaw = z.infer<typeof AprobacionRawSchema>

export type Cotizacion = {
  referencia: string | null
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  validez_hasta: string | null
  texto: string
}

export type Aprobacion = { de: string; fecha: string; aprobado: boolean; texto: string }

export type Factura = { numero: string; fecha: string; total: number }

export type Paquete = {
  correo: z.infer<typeof CorreoSchema>
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: Aprobacion | null
  factura: Factura | null
  faltantes: string[]
}

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
export type Proveedor = z.infer<typeof ProveedorSchema>

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string().optional(), tope: z.number() })),
})
export type CentroCosto = z.infer<typeof CentroCostoSchema>

export const IndicadorIvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
export const CondicionPagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })

export type Maestros = {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  iva: z.infer<typeof IndicadorIvaSchema>[]
  pagos: z.infer<typeof CondicionPagoSchema>[]
}

export type Bloqueo = { codigo: string; detalle: string; accion: string }
export type Confirmacion = { codigo: string; detalle: string; valores?: Record<string, string | number> }
export type Derivado = { valor: string; fuente: string; detalle: string }

export type Validacion = {
  apta: boolean
  bloqueos: Bloqueo[]
  confirmaciones: Confirmacion[]
  derivados: Record<string, Derivado>
  retroactiva: boolean
  reglas: Array<{ codigo: string; estado: "ok" | "bloqueo" | "confirmacion" | "derivado" | "no_evaluable"; detalle: string }>
}

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({ email: z.string(), fecha_aprobacion: z.string(), evidencia_sha256: z.string() }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int(),
        descripcion: z.string().max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }
