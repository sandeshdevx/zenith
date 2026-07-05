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
import { scoreMessage, type ScoreJob } from "./risk.js";

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
    } catch (err) {
      console.error(`[purge] failed: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, env.PURGE_INTERVAL_SECONDS * 1000));
  }
}

async function main() {
  await boss.start();
  await boss.createQueue("score_message");
  await boss.work<ScoreJob>("score_message", async (jobs) => {
    for (const job of jobs) {
      const outcome = await scoreMessage(pool, riskAdapters, job.data);
      if (outcome?.alertEligible) {
        // Counsellor alert dispatch arrives in Phase 5; the eligibility event
        // is already persisted by scoreMessage.
        console.log(`[risk] session alert-eligible at tier ${outcome.sessionTier}`);
      }
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
