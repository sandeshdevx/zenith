import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z
    .string()
    .default("postgres://zenith:zenith@localhost:5432/zenith"),
  OLLAMA_URL: z.string().default("http://localhost:11434"),
  /** Any open-weights chat model served by Ollama (PRD default: Mistral 7B). */
  OLLAMA_MODEL: z.string().default("mistral:7b-instruct-q4_K_M"),
  LLM_NUM_PREDICT: z.coerce.number().default(200),
  LLM_TIMEOUT_MS: z.coerce.number().default(120000),
  /** GPU layers for Ollama; 0 forces CPU (leave unset for auto). */
  OLLAMA_NUM_GPU: z.coerce.number().optional(),
  /** Jitsi instance for anonymous video handoff (self-hosters: your own). */
  JITSI_BASE_URL: z.string().default("https://meet.jit.si"),
  /**
   * AI Buddy provider. "ollama" (default) keeps conversation text fully
   * local. "openai-compat" points at any OpenAI-style endpoint (Groq,
   * Gemini's OpenAI mode, OpenRouter, or a local vLLM) for faster replies —
   * the provider then sees conversation text (never any identity).
   * Crisis detection (CSI) always stays local either way.
   */
  /** faster-whisper sidecar (services/inference) for cross-browser voice. */
  STT_URL: z.string().default("http://127.0.0.1:8090"),
  LLM_PROVIDER: z.enum(["ollama", "openai-compat"]).default("ollama"),
  LLM_API_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_API_MODEL: z.string().optional(),
  SESSION_TOKEN_SECRET: z.string().min(16).default("dev-only-secret-change-me"),
  /** Set true behind HTTPS in production. */
  COOKIE_SECURE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
});

export type Config = z.infer<typeof envSchema>;

/** Load a .env file if present (workspace cwd first, then repo root). */
function loadDotenv(): void {
  for (const candidate of [".env", "../../.env"]) {
    try {
      process.loadEnvFile(candidate);
      return;
    } catch {
      /* try next */
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) loadDotenv();
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.message}`);
  }
  return parsed.data;
}
