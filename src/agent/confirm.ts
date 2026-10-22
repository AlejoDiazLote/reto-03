const NEGATIVO = /\b(no|cancel[ao]?|cancelar|rechaz[oa]|detente|espera|todav[ií]a no|a[uú]n no|no confirmo)\b/i
const AFIRMATIVO = /\b(s[ií]|confirmo|confirmado|confirma|ok|okay|dale|procede|proceder|adelante|apruebo|aprobado|de acuerdo|cr[eé]ala|cr[eé]ala ya|hazlo)\b/i

export function esConfirmacion(mensaje: string): boolean {
  const texto = mensaje.trim()
  if (texto.length === 0 || texto.length > 200) return false
  if (NEGATIVO.test(texto)) return false
  return AFIRMATIVO.test(texto)
}

export function casoMencionado(mensaje: string): string | null {
  const m = mensaje.toLowerCase().match(/\bsol-\d{3,}\b/)
  return m?.[0] ?? null
}
