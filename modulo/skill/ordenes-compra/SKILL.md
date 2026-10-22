---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia (maestros, reglas de control RC1–RC10, OC retroactivas, payload SAP). Úsalo al procesar solicitudes de compra con las herramientas oc_*.
---

## Proceso de órdenes de compra en Periferia

Cada compra llega a administración por correo con tres piezas:

1. El Excel de solicitud, normalizado en `solicitud.json`.
2. La cotización del proveedor, normalizada en `cotizacion.txt`.
3. El correo de aprobación del líder, normalizado en `aprobacion.json`.

Si ya llegó la factura, también viene `factura.txt`. La analista crea la OC en SAP y adjunta el correo de aprobación en PDF como evidencia.

Cada caso es una carpeta en `fixtures/reto-03/solicitudes/<caso>` (por ejemplo `sol-001`). El `solicitud_id` (por ejemplo `SOL-2026-001`) es la referencia de negocio, y la idempotencia en SAP se controla por ese valor.

## Maestros

- **Proveedores**: código SAP, NIT, nombre, condición de pago por defecto, indicador de IVA por defecto y estado activo.
- **Centros de costo**: subáreas válidas y aprobadores con su tope de monto.
- **Indicadores de IVA**: C0 excluido, C1 19 %, C2 5 %.
- **Condiciones de pago**: Z000 inmediato, Z015, Z030 y Z060 días fecha factura.

## Reglas de control

| Regla | Qué verifica | Efecto |
|---|---|---|
| RC1 | El proveedor existe por NIT (o por nombre si no hay NIT) y está activo | Bloqueo |
| RC2 | La aprobación existe, dice "Aprobado" y viene de un aprobador del centro de costo | Bloqueo |
| RC3 | El valor total no supera el tope de ese aprobador | Bloqueo |
| RC4 | La subárea pertenece al centro de costo | Bloqueo |
| RC5 | La cotización difiere 2 % o menos de la solicitud; si no hay cotización también se confirma | Confirmación |
| RC6 | Sin indicador de IVA → se deriva del proveedor | Confirmación + derivado |
| RC7 | Sin condición de pago → se deriva del proveedor | Derivado (solo se informa) |
| RC8 | La factura es anterior a la solicitud → OC retroactiva | Confirmación + marca en control |
| RC9 | La aprobación es anterior a la solicitud | Confirmación |
| RC10 | cantidad × valor unitario = valor total (± 1) | Bloqueo |

- **Bloqueo**: la OC no se crea. Se devuelve el motivo y la acción sugerida, por ejemplo crear el proveedor en datos maestros o pedir la aprobación a quien tiene el tope.
- **Confirmación**: la OC solo se crea si la analista confirma explícitamente.
- **Derivado**: valor completado desde un maestro. Se informa siempre.

## OC retroactivas

Una OC es retroactiva cuando la factura llegó antes de la solicitud: la compra se hizo sin OC previa y, en general, sin cotización formal. La dirección quiere medir este desvío. Toda OC retroactiva queda con `retroactiva=true` en `out/control.csv`, y la analista debe saberlo antes de confirmar.

## Payload SAP

- Sociedad y organización de compras: `1000`.
- La posición se numera desde 10. El texto breve tiene un máximo de 40 caracteres; si se recorta, queda la excepción `TXT40` con el texto original.
- La unidad se deriva de la descripción: `H` si son horas, `MES` si es un cobro mensual y `UN` en los demás casos.
- Cada valor del payload es trazable a su fuente en `out/<caso>/trazabilidad.json`.
- La evidencia de aprobación queda en `out/<caso>/aprobacion.txt` y `.pdf`. Su sha256 va en `aprobador.evidencia_sha256`.
- Los números de OC son secuenciales desde `4500000001`. Crear dos veces la misma solicitud devuelve el número existente.

## Glosario

- **OC**: orden de compra (documento SAP de tipo pedido).
- **Centro de costo / subárea**: imputación contable del gasto.
- **Indicador de IVA**: código SAP que define la tasa de IVA de la posición.
- **Condición de pago**: plazo de pago al proveedor (código Z0xx).
