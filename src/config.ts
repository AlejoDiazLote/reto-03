function entero(nombre: string, porDefecto: number): number {
  const valor = Number(process.env[nombre])
  return Number.isFinite(valor) && valor > 0 ? Math.floor(valor) : porDefecto
}

export const config = {
  port: entero("PORT", 3000),
  provider: process.env.LLM_PROVIDER ?? "gemini",
  baseUrl: process.env.LLM_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai",
  apiKey: process.env.LLM_API_KEY ?? process.env.GEMINI_API_KEY ?? "",
  model: process.env.LLM_MODEL ?? "gemini-3.8-flash",
  maxIterations: entero("MAX_ITERATIONS", 25),
  maxTokensSession: entero("MAX_TOKENS_SESSION", 200000),
  timeoutMs: entero("LLM_TIMEOUT_MS", 30000),
  rateLimitPerMin: entero("RATE_LIMIT_PER_MIN", 20),
  accessKey: process.env.ACCESS_KEY ?? "",
}
