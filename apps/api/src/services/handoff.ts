/**
 * Human handoff (PRD Flow B steps 3–6 + Flow C option A).
 * The offer to the user is always delivered in the buddy's own voice —
 * never a banner, never a system alert, never a hint that anything was
 * detected (PRD: "framed as a positive offer").
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { persistMessage } from "./messages.js";
import { broadcast } from "../realtime/registry.js";

// PRD Flow B step 4 wording.
const OFFER_TEXT =
  "I think it might help to talk to someone right now — there's a person available if you want. No pressure at all; I'm here either way.";

export function newRoomUrl(jitsiBaseUrl: string): string {
  return `${jitsiBaseUrl.replace(/\/$/, "")}/zenith-${randomUUID()}`;
}

/** Stores the room and delivers the buddy-framed offer to the user's tabs. */
export async function offerHandoffToUser(
  pool: Pool,
  sessionId: string,
  roomUrl: string,
): Promise<void> {
  await pool.query("UPDATE sessions SET handoff_room = $2 WHERE id = $1", [sessionId, roomUrl]);
  const persisted = await persistMessage(pool, sessionId, "buddy", OFFER_TEXT);
  if (persisted) {
    broadcast(sessionId, {
      type: "message.sent",
      messageId: persisted.messageId,
      sender: "buddy",
      content: OFFER_TEXT,
      createdAt: persisted.createdAt,
    });
  }
  broadcast(sessionId, { type: "handoff.offer", roomUrl });
  await pool.query(
    `INSERT INTO session_events (session_id, event_type, payload)
     VALUES ($1, 'handoff_offered', '{}')`,
    [sessionId],
  );
}

export async function acceptHandoff(pool: Pool, sessionId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `UPDATE sessions SET status = 'handoff_active', last_active_at = now()
     WHERE id = $1 AND status IN ('escalation_pending','active') AND handoff_room IS NOT NULL
     RETURNING handoff_room`,
    [sessionId],
  );
  if (!rows[0]) return null;
  await pool.query(
    `INSERT INTO session_events (session_id, event_type, payload)
     VALUES ($1, 'handoff_accepted', '{}')`,
    [sessionId],
  );
  return rows[0].handoff_room;
}

/** User said "not now" — the buddy carries on; the counsellor's alert stays
 *  accepted and the room remains open for the alert's lifetime (PRD). */
export async function declineHandoff(pool: Pool, sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET status = 'active', last_active_at = now()
     WHERE id = $1 AND status = 'escalation_pending'`,
    [sessionId],
  );
  await pool.query(
    `INSERT INTO session_events (session_id, event_type, payload)
     VALUES ($1, 'handoff_declined', '{}')`,
    [sessionId],
  );
}

/**
 * User-initiated escalation (PRD Flow C / manual escape hatch): raises an
 * ORANGE alert directly — no detection involved, the user asked.
 */
export async function escalateByUser(pool: Pool, sessionId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO alerts (session_id, tier, expires_at)
     VALUES ($1, 'orange', now() + interval '10 minutes')
     ON CONFLICT (session_id) WHERE status = 'active' DO NOTHING
     RETURNING id`,
    [sessionId],
  );
  if (!rows[0]) return false; // an alert is already live for this session
  await pool.query("SELECT pg_notify('zenith_alert_new', $1)", [String(rows[0].id)]);
  await pool.query(
    `INSERT INTO session_events (session_id, event_type, payload)
     VALUES ($1, 'user_escalated', '{}')`,
    [sessionId],
  );
  return true;
}
