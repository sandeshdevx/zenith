/**
 * Zenith background worker.
 * - Purge loop: deletes ended/inactive sessions (Phase 1).
 * - Risk queue consumer: scores user messages off the reply path (Phase 4).
 */
import { Pool } from "pg";
import PgBoss from "pg-boss";
import { z } from "zod";
import { KeywordSentinelAdapter } from "@zenith/adapters";
import { purgeExpiredSessions } from "./purge.js";
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
});

const env = envSchema.parse(process.env);
const pool = new Pool({ connectionString: env.DATABASE_URL, max: 5 });
pool.on("error", () => {});

const riskAdapters = [new KeywordSentinelAdapter()];

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

  await boss.work<ScoreJob>("score_message", async (jobs) => {
    for (const job of jobs) {
      const outcome = await scoreMessage(pool, riskAdapters, job.data);
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
