import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib"
import { outCasoDir } from "./paths.ts"
import type { AprobacionRaw } from "./types.ts"

export function contenidoAprobacion(a: AprobacionRaw): string {
  const lineas = [
    `De: ${a.de}`,
    `Para: ${a.para}`,
    ...(a.cc && a.cc.length > 0 ? [`CC: ${a.cc.join(", ")}`] : []),
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto}`,
    "",
    a.cuerpo,
  ]
  return lineas.join("\n")
}

export function sha256(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex")
}

function envolver(texto: string, font: PDFFont, size: number, ancho: number): string[] {
  const salida: string[] = []
  for (const parrafo of texto.split("\n")) {
    let linea = ""
    for (const palabra of parrafo.split(" ")) {
      const candidata = linea ? `${linea} ${palabra}` : palabra
      if (font.widthOfTextAtSize(candidata, size) > ancho && linea) {
        salida.push(linea)
        linea = palabra
      } else {
        linea = candidata
      }
    }
    salida.push(linea)
  }
  return salida
}

async function generarPdf(caso: string, contenido: string, hash: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(`Evidencia de aprobación ${caso}`)
  pdf.setCreator("Agente Órdenes de Compra SAP")
  pdf.setCreationDate(new Date("2026-01-01T00:00:00Z"))
  pdf.setModificationDate(new Date("2026-01-01T00:00:00Z"))
  const page = pdf.addPage([595, 842])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  let y = 790
  page.drawText("Evidencia de aprobación de orden de compra", { x: 50, y, size: 14, font: bold, color: rgb(0.08, 0.38, 0.11) })
  y -= 18
  page.drawText(`Caso: ${caso}`, { x: 50, y, size: 9, font, color: rgb(0.4, 0.4, 0.4) })
  y -= 28
  for (const linea of envolver(contenido, font, 11, 495)) {
    page.drawText(linea, { x: 50, y, size: 11, font })
    y -= 15
  }
  y -= 20
  page.drawText("SHA-256 del contenido:", { x: 50, y, size: 9, font: bold })
  page.drawText(hash, { x: 50, y: y - 13, size: 8, font })
  return pdf.save()
}

export type Evidencia = { ruta: string; ruta_pdf: string; sha256: string }

export async function escribirEvidencia(root: string, caso: string, aprobacion: AprobacionRaw): Promise<Evidencia> {
  const contenido = contenidoAprobacion(aprobacion)
  const hash = sha256(contenido)
  const dir = outCasoDir(root, caso)
  await mkdir(dir, { recursive: true })
  const txt = `${contenido}\n\n---\nsha256: ${hash}\n`
  await writeFile(join(dir, "aprobacion.txt"), txt, "utf8")
  await writeFile(join(dir, "aprobacion.pdf"), await generarPdf(caso, contenido, hash))
  return { ruta: `out/${caso}/aprobacion.txt`, ruta_pdf: `out/${caso}/aprobacion.pdf`, sha256: hash }
}
