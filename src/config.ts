function entero(nombre: string, porDefecto: number): number {
  const valor = Number(process.env[nombre])
  return Number.isFinite(valor) && valor > 0 ? Math.floor(valor) : porDefecto
}

export const config = {
  port: entero("PORT", 3000),
  provider: process.env.LLM_PROVIDER ?? "groq",
  baseUrl: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
  apiKey: process.env.LLM_API_KEY ?? process.env.GROQ_API_KEY ?? "",
  model: process.env.LLM_MODEL ?? "llama-3.3-70b-versatile",
  maxIterations: entero("MAX_ITERATIONS", 25),
  maxTokensSession: entero("MAX_TOKENS_SESSION", 200000),
  timeoutMs: entero("LLM_TIMEOUT_MS", 30000),
  rateLimitPerMin: entero("RATE_LIMIT_PER_MIN", 20),
  accessKey: process.env.ACCESS_KEY ?? "",
}
