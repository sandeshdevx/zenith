import { OllamaLlmAdapter } from "@zenith/adapters";
import { loadConfig } from "./config.js";
import { getPool } from "./db/pool.js";
import { createBuddyService } from "./services/buddy.js";
import { buildServer, type ServerOptions } from "./server.js";

const config = loadConfig();

// Late-bound so the buddy service can use the app logger.
let onUserMessage: ServerOptions["onUserMessage"];
const app = buildServer(config, {
  onUserMessage: (sessionId, content) => onUserMessage?.(sessionId, content),
});

const llm = new OllamaLlmAdapter({
  baseUrl: config.OLLAMA_URL,
  model: config.OLLAMA_MODEL,
  numPredict: config.LLM_NUM_PREDICT,
  timeoutMs: config.LLM_TIMEOUT_MS,
});
const buddy = createBuddyService(getPool(config), llm, app.log);
onUserMessage = buddy.onUserMessage;

app
  .listen({ port: config.PORT, host: config.HOST })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    buddy.stop();
    await app.close();
    process.exit(0);
  });
}
