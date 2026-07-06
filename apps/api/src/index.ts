import PgBoss from "pg-boss";
import { OllamaLlmAdapter, OpenAICompatLlmAdapter, type LlmAdapter } from "@zenith/adapters";
import { loadConfig } from "./config.js";
import { getPool } from "./db/pool.js";
import { createBuddyService } from "./services/buddy.js";
import { buildServer, type ServerOptions } from "./server.js";

const config = loadConfig();

// Late-bound so the buddy service can use the app logger.
let onUserMessage: ServerOptions["onUserMessage"];
const app = buildServer(config, {
  onUserMessage: (sessionId, content, messageId) =>
    onUserMessage?.(sessionId, content, messageId),
});

// Risk scoring queue (Phase 4): producer side. Payloads carry IDs only —
// the worker reads content from the DB. Enqueue failures must never break
// the conversation path.
const boss = new PgBoss({ connectionString: config.DATABASE_URL });
boss.on("error", (err) => app.log.error({ err: { message: err.message } }, "queue error"));
let queueReady = false;
void boss
  .start()
  .then(() => boss.createQueue("score_message"))
  .then(() => {
    queueReady = true;
  })
  .catch((err) =>
    app.log.error({ err: { message: err.message } }, "risk queue unavailable"),
  );

let llm: LlmAdapter;
if (config.LLM_PROVIDER === "openai-compat" && config.LLM_API_BASE_URL && config.LLM_API_MODEL) {
  llm = new OpenAICompatLlmAdapter({
    baseUrl: config.LLM_API_BASE_URL,
    apiKey: config.LLM_API_KEY,
    model: config.LLM_API_MODEL,
    maxTokens: config.LLM_NUM_PREDICT,
    timeoutMs: config.LLM_TIMEOUT_MS,
  });
} else {
  llm = new OllamaLlmAdapter({
    baseUrl: config.OLLAMA_URL,
    model: config.OLLAMA_MODEL,
    numPredict: config.LLM_NUM_PREDICT,
    timeoutMs: config.LLM_TIMEOUT_MS,
    numGpu: config.OLLAMA_NUM_GPU,
  });
}
app.log.info(`AI Buddy provider: ${llm.name}`);
const buddy = createBuddyService(getPool(config), llm, app.log);
onUserMessage = (sessionId, content, messageId) => {
  buddy.onUserMessage(sessionId, content);
  if (queueReady) {
    void boss
      .send("score_message", { sessionId, messageId })
      .catch((err) =>
        app.log.error({ err: { message: err.message } }, "risk enqueue failed"),
      );
  }
};

app
  .listen({ port: config.PORT, host: config.HOST })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    buddy.stop();
    await boss.stop({ graceful: false }).catch(() => {});
    await app.close();
    process.exit(0);
  });
}
