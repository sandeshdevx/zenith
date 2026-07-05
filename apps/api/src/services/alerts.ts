/**
 * Crisis alert lifecycle (PRD Flow B).
 * The whitelist serializer here is the ONLY path from anonymous-session data
 * to the counsellor plane: session UUID, tier, timestamps, last three turns.
 * Nothing else can cross, by construction.
 */
import type { Pool } from "pg";
import type { AlertPayload } from "@zenith/contracts";

export const ALERT_TTL_MINUTES = 10;
const LAST_TURNS = 3;

export async function serializeAlert(pool: Pool, alertRow: {
  id: string | number;
  session_id: string;
  tier: "orange" | "red";
  created_at: Date;
  expires_at: Date;
  handoff_room?: string | null;
}): Promise<AlertPayload> {
  const turns = await pool.query(
    `SELECT sender, content FROM (
       SELECT id, sender, content FROM session_messages
       WHERE session_id = $1 ORDER BY id DESC LIMIT $2
     ) recent ORDER BY id ASC`,
    [alertRow.session_id, LAST_TURNS],
  );
  return {
    alertId: String(alertRow.id),
    sessionId: alertRow.session_id,
    tier: alertRow.tier,
    createdAt: new Date(alertRow.created_at).toISOString(),
    expiresAt: new Date(alertRow.expires_at).toISOString(),
    lastTurns: turns.rows.map((r) => ({ sender: r.sender, content: r.content })),
    ...(alertRow.handoff_room ? { roomUrl: alertRow.handoff_room } : {}),
  };
}

export async function getAlertById(pool: Pool, alertId: string): Promise<AlertPayload | null> {
  const { rows } = await pool.query(
    `SELECT a.id, a.session_id, a.tier, a.created_at, a.expires_at, s.handoff_room
     FROM alerts a JOIN sessions s ON s.id = a.session_id
     WHERE a.id = $1 AND a.status = 'active'`,
    [alertId],
  );
  return rows[0] ? serializeAlert(pool, rows[0]) : null;
}

export async function listActiveAlerts(pool: Pool): Promise<AlertPayload[]> {
  const { rows } = await pool.query(
    `SELECT a.id, a.session_id, a.tier, a.created_at, a.expires_at, s.handoff_room
     FROM alerts a JOIN sessions s ON s.id = a.session_id
     WHERE a.status = 'active' AND a.expires_at > now()
     ORDER BY a.tier = 'red' DESC, a.created_at ASC`,
  );
  return Promise.all(rows.map((r) => serializeAlert(pool, r)));
}

export interface AcceptResult {
  alertId: string;
  sessionId: string;
  tier: "orange" | "red";
}

/** Atomic claim — exactly one counsellor can win a session's active alert. */
export async function acceptAlert(
  pool: Pool,
  sessionId: string,
  counsellorId: string,
): Promise<AcceptResult | null> {
  const { rows } = await pool.query(
    `UPDATE alerts SET status = 'accepted', counsellor_id = $2, accepted_at = now()
     WHERE session_id = $1 AND status = 'active' AND expires_at > now()
     RETURNING id, session_id, tier`,
    [sessionId, counsellorId],
  );
  const row = rows[0];
  if (!row) return null;

  await pool.query(
    `UPDATE sessions SET status = 'escalation_pending', counsellor_id = $2
     WHERE id = $1 AND status = 'active'`,
    [sessionId, counsellorId],
  );
  await pool.query(
    `INSERT INTO session_events (session_id, event_type, payload)
     VALUES ($1, 'alert_accepted', $2)`,
    [sessionId, JSON.stringify({ alertId: String(row.id) })],
  );
  return { alertId: String(row.id), sessionId: row.session_id, tier: row.tier };
}

export async function declineAlert(
  pool: Pool,
  sessionId: string,
  counsellorId: string,
): Promise<void> {
  // Per-counsellor decline, no penalty (PRD); the alert stays active for others.
  await pool.query(
    `INSERT INTO session_events (session_id, event_type, payload)
     VALUES ($1, 'alert_declined', $2)`,
    [sessionId, JSON.stringify({ counsellorId })],
  );
}
