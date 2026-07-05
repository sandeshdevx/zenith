/**
 * Zenith background worker.
 * Phase 1: the purge job — the enforcement mechanism behind "nothing stored".
 * Deletes ended sessions immediately and inactive sessions after the
 * inactivity window. Cascades remove messages and events. Only aggregate
 * counts are recorded, never content.
 */
import { Pool } from "pg";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .default("postgres://zenith:zenith@localhost:5432/zenith"),
  PURGE_INTERVAL_SECONDS: z.coerce.number().default(60),
  SESSION_INACTIVITY_MINUTES: z.coerce.number().default(10),
});

const env = envSchema.parse(process.env);
const pool = new Pool({ connectionString: env.DATABASE_URL, max: 3 });
pool.on("error", () => {});

async function purgeExpiredSessions(): Promise<number> {
  // ON DELETE CASCADE removes session_messages and session_events with the row.
  const { rowCount } = await pool.query(
    `DELETE FROM sessions
     WHERE status = 'ended'
        OR last_active_at < now() - make_interval(mins => $1)`,
    [env.SESSION_INACTIVITY_MINUTES],
  );
  const purged = rowCount ?? 0;
  if (purged > 0) {
    await pool.query(
      `INSERT INTO system_audit_logs (actor, action, metadata)
       VALUES ('worker', 'session_purge', $1)`,
      [JSON.stringify({ purged })],
    );
  }
  return purged;
}

let running = true;

async function loop() {
  while (running) {
    try {
      const purged = await purgeExpiredSessions();
      if (purged > 0) console.log(`[purge] removed ${purged} session(s)`);
    } catch (err) {
      console.error(`[purge] failed: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, env.PURGE_INTERVAL_SECONDS * 1000));
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    running = false;
    await pool.end();
    process.exit(0);
  });
}

console.log(
  `[worker] purge loop started (every ${env.PURGE_INTERVAL_SECONDS}s, inactivity window ${env.SESSION_INACTIVITY_MINUTES}m)`,
);
loop();
