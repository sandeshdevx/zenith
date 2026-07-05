/**
 * Purge job — the enforcement mechanism behind "nothing stored".
 * Deletes ended sessions immediately and inactive sessions after the
 * inactivity window; cascades remove messages, events, and assessments.
 * Only aggregate counts are recorded.
 */
import type { Pool } from "pg";

export async function purgeExpiredSessions(
  pool: Pool,
  inactivityMinutes: number,
): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM sessions
     WHERE status = 'ended'
        OR last_active_at < now() - make_interval(mins => $1)`,
    [inactivityMinutes],
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
