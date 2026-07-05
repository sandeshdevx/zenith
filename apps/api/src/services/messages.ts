/**
 * Message persistence shared by the REST route and the WebSocket gateway.
 * REST/DB is the source of truth; sockets are transport only — a client that
 * reconnects re-fetches recent messages and loses nothing.
 */
import type { Pool } from "pg";
import type { MessageSender, ProsodyFeaturesDto, SessionMessage } from "@zenith/contracts";

export interface PersistedMessage {
  messageId: string;
  createdAt: string;
}

/** Returns null when the session does not exist or is not accepting messages. */
export async function persistMessage(
  pool: Pool,
  sessionId: string,
  sender: MessageSender,
  content: string,
  prosody?: ProsodyFeaturesDto,
): Promise<PersistedMessage | null> {
  const { rows } = await pool.query(
    `UPDATE sessions SET last_active_at = now()
     WHERE id = $1 AND status IN ('active','escalation_pending','handoff_active')
     RETURNING id`,
    [sessionId],
  );
  if (rows.length === 0) return null;

  const inserted = await pool.query(
    `INSERT INTO session_messages (session_id, sender, content, prosody)
     VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    [sessionId, sender, content, prosody ? JSON.stringify(prosody) : null],
  );
  return {
    messageId: String(inserted.rows[0].id),
    createdAt: new Date(inserted.rows[0].created_at).toISOString(),
  };
}

/** Most recent messages in chronological order, for reconnect context. */
export async function listRecentMessages(
  pool: Pool,
  sessionId: string,
  limit = 50,
): Promise<SessionMessage[]> {
  const { rows } = await pool.query(
    `SELECT id, sender, content, created_at
     FROM (
       SELECT id, sender, content, created_at
       FROM session_messages WHERE session_id = $1
       ORDER BY id DESC LIMIT $2
     ) recent
     ORDER BY id ASC`,
    [sessionId, limit],
  );
  return rows.map((r) => ({
    messageId: String(r.id),
    sender: r.sender,
    content: r.content,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}
