/**
 * Zenith background worker.
 * - Purge loop: deletes ended/inactive sessions (Phase 1).
 * - Risk queue consumer: scores user messages off the reply path (Phase 4).
 */
import { Pool } from "pg";
import PgBoss from "pg-boss";
import { z } from "zod";
import { KeywordSentinelAdapter, OllamaEmbeddingAdapter } from "@zenith/adapters";
import { purgeExpiredSessions } from "./purge.js";
import { CsiEngine } from "./csi.js";
import {
  deliverRedFallback,
  expireStaleAlerts,
  scoreMessage,
  RED_FALLBACK_DELAY_SECONDS,
  type ScoreJob,
} from "./risk.js";

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .default("postgres://zenith:zenith@localhost:5432/zenith"),
  PURGE_INTERVAL_SECONDS: z.coerce.number().default(60),
  SESSION_INACTIVITY_MINUTES: z.coerce.number().default(10),
  OLLAMA_URL: z.string().default("http://localhost:11434"),
  EMBED_MODEL: z.string().default("nomic-embed-text"),
  JITSI_BASE_URL: z.string().default("https://meet.jit.si"),
});

const env = envSchema.parse(process.env);
const pool = new Pool({ connectionString: env.DATABASE_URL, max: 5 });
pool.on("error", () => {});

const csiEngine = new CsiEngine(
  new KeywordSentinelAdapter(),
  // CPU-only hosts need patience: the one-time 19-text pre-encoding batch
  // can take ~30s cold; per-message embeds are single texts and fast.
  new OllamaEmbeddingAdapter({ baseUrl: env.OLLAMA_URL, model: env.EMBED_MODEL, timeoutMs: 180_000 }),
);

const boss = new PgBoss({ connectionString: env.DATABASE_URL });
boss.on("error", (err) => console.error(`[queue] ${err.message}`));

let running = true;

async function purgeLoop() {
  while (running) {
    try {
      const purged = await purgeExpiredSessions(pool, env.SESSION_INACTIVITY_MINUTES);
      if (purged > 0) console.log(`[purge] removed ${purged} session(s)`);
      const expired = await expireStaleAlerts(pool);
      if (expired > 0) console.log(`[alerts] expired ${expired} stale alert(s)`);
    } catch (err) {
      console.error(`[purge] failed: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, env.PURGE_INTERVAL_SECONDS * 1000));
  }
}

async function main() {
  await boss.start();
  await boss.createQueue("score_message");
  await boss.createQueue("red_fallback");

  // Pre-encode PHQ-9/GAD-7 items + distress prototypes (patent: at init).
  // Degrades to sentinel-only scoring when the embedder is unavailable and
  // retries every 60s until semantic scoring comes online.
  const semantic = await csiEngine.initialize();
  console.log(`[csi] semantic scoring ${semantic ? "online" : "offline — sentinel only"}`);
  const semanticRetry = setInterval(() => {
    if (!csiEngine.isSemanticReady()) {
      void csiEngine.initialize().then((ok) => {
        if (ok) console.log("[csi] semantic scoring online");
      });
    }
  }, 60_000);
  semanticRetry.unref?.();

  await boss.work<ScoreJob>("score_message", async (jobs) => {
    for (const job of jobs) {
      const outcome = await scoreMessage(pool, csiEngine, job.data, env.JITSI_BASE_URL);
      if (outcome?.raisedAlertId) {
        console.log(`[risk] alert raised at tier ${outcome.sessionTier}`);
        if (outcome.sessionTier === "red") {
          await boss.send(
            "red_fallback",
            { alertId: outcome.raisedAlertId },
            { startAfter: RED_FALLBACK_DELAY_SECONDS },
          );
        }
      }
    }
  });

  await boss.work<{ alertId: string }>("red_fallback", async (jobs) => {
    for (const job of jobs) {
      const delivered = await deliverRedFallback(pool, job.data.alertId);
      if (delivered) console.log("[risk] red fallback delivered (no counsellor in 90s)");
    }
  });
  console.log(
    `[worker] purge every ${env.PURGE_INTERVAL_SECONDS}s (window ${env.SESSION_INACTIVITY_MINUTES}m); risk consumer online`,
  );
  await purgeLoop();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    running = false;
    await boss.stop({ graceful: true }).catch(() => {});
    await pool.end();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`[worker] fatal: ${err.message}`);
  process.exit(1);
});
