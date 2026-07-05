/**
 * Risk scoring consumer — feeds each user turn through the CSI engine
 * (patent modules 102–106) and drives the Tiered Response Engine:
 *   Tier 1 (green):  nothing changes.
 *   Tier 2 (yellow): session tier set — the buddy passively weaves in
 *                    resource references (handled by the API's prompt builder).
 *   Tier 3 (orange): silent counsellor alert (session token + tier only).
 *   Tier 4 (red):    encrypted anonymous video room created immediately,
 *                    link attached for counsellors, buddy-framed prompt to
 *                    the user — plus the 90s helpline fallback if unclaimed.
 *
 * PRD noise control retained: Tier 3/4 dispatch still requires 2 of the
 * last 3 assessments at orange/red. Tiers never downgrade.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { RISK_TIER_RANK, type ProsodyFeatures, type RiskTier } from "@zenith/adapters";
import type { CsiEngine } from "./csi.js";

export interface ScoreJob {
  sessionId: string;
  messageId: string;
}

export interface ScoreOutcome {
  tier: RiskTier;
  csi: number;
  sessionTier: RiskTier;
  alertEligible: boolean;
  raisedAlertId?: string;
}

const OFFER_TEXT =
  "I think it might help to talk to someone right now — there's a person available if you want. No pressure at all; I'm here either way.";

export async function scoreMessage(
  pool: Pool,
  engine: CsiEngine,
  job: ScoreJob,
  jitsiBaseUrl: string,
): Promise<ScoreOutcome | null> {
  const { rows } = await pool.query(
    `SELECT content, prosody,
            (SELECT count(*) FROM session_messages
             WHERE session_id = $2 AND sender = 'user' AND id <= $1) AS turn_count
     FROM session_messages
     WHERE id = $1 AND session_id = $2 AND sender = 'user'`,
    [job.messageId, job.sessionId],
  );
  const row = rows[0];
  if (!row) return null; // purged or ended — nothing to do

  const result = await engine.assess(pool, {
    sessionId: job.sessionId,
    messageId: job.messageId,
    content: row.content,
    prosody: (row.prosody as ProsodyFeatures | null) ?? null,
    turnCount: Number(row.turn_count ?? 1),
  });

  await pool.query(
    `INSERT INTO risk_assessments (session_id, message_id, tier, score, source, signals, s1, s2, s3, csi)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      job.sessionId,
      job.messageId,
      result.tier,
      result.csi / 100,
      engine.isSemanticReady() ? "csi:sentinel+semantic" : "csi:sentinel",
      JSON.stringify(result.signals),
      result.s1,
      result.s2,
      result.s3,
      result.csi,
    ],
  );

  return applyTieredResponse(pool, job.sessionId, result.tier, result.csi, jitsiBaseUrl);
}

async function applyTieredResponse(
  pool: Pool,
  sessionId: string,
  latest: RiskTier,
  csi: number,
  jitsiBaseUrl: string,
): Promise<ScoreOutcome> {
  const current = await pool.query("SELECT risk_tier, handoff_room FROM sessions WHERE id = $1", [
    sessionId,
  ]);
  const currentTier: RiskTier = current.rows[0]?.risk_tier ?? "green";
  const existingRoom: string | null = current.rows[0]?.handoff_room ?? null;

  let target: RiskTier = currentTier;
  let alertEligible = false;

  if (latest === "orange" || latest === "red") {
    const recent = await pool.query(
      "SELECT tier FROM risk_assessments WHERE session_id = $1 ORDER BY id DESC LIMIT 3",
      [sessionId],
    );
    const highCount = recent.rows.filter(
      (r: { tier: RiskTier }) => r.tier === "orange" || r.tier === "red",
    ).length;
    if (highCount >= 2 && RISK_TIER_RANK[latest] > RISK_TIER_RANK[currentTier]) {
      target = latest;
      alertEligible = true;
    }
  } else if (latest === "yellow" && RISK_TIER_RANK[latest] > RISK_TIER_RANK[currentTier]) {
    target = "yellow"; // Tier 2: buddy prompt builder picks this up
  }

  let raisedAlertId: string | undefined;
  if (target !== currentTier) {
    await pool.query("UPDATE sessions SET risk_tier = $2 WHERE id = $1", [sessionId, target]);
    if (alertEligible) {
      await pool.query(
        `INSERT INTO session_events (session_id, event_type, payload)
         VALUES ($1, 'risk_alert_eligible', $2)`,
        [sessionId, JSON.stringify({ tier: target, csi })],
      );
      raisedAlertId = (await raiseAlert(pool, sessionId, target as "orange" | "red")) ?? undefined;

      // Tier 4 (claim 6): create the encrypted anonymous video session now
      // and prompt the user — the room is ready before any counsellor accepts.
      if (target === "red" && raisedAlertId && !existingRoom) {
        await openHandoffRoom(pool, sessionId, jitsiBaseUrl);
      }
    }
  }

  return { tier: latest, csi, sessionTier: target, alertEligible, raisedAlertId };
}

/** Tier 4: room + buddy-framed prompt, delivered via the NOTIFY bridges. */
async function openHandoffRoom(pool: Pool, sessionId: string, jitsiBaseUrl: string): Promise<void> {
  const roomUrl = `${jitsiBaseUrl.replace(/\/$/, "")}/zenith-${randomUUID()}`;
  await pool.query("UPDATE sessions SET handoff_room = $2 WHERE id = $1", [sessionId, roomUrl]);

  const inserted = await pool.query(
    `INSERT INTO session_messages (session_id, sender, content)
     VALUES ($1, 'buddy', $2) RETURNING id`,
    [sessionId, OFFER_TEXT],
  );
  await pool.query("SELECT pg_notify('zenith_user_message', $1)", [
    `${sessionId}:${inserted.rows[0].id}`,
  ]);
  await pool.query("SELECT pg_notify('zenith_handoff_offer', $1)", [`${sessionId}:${roomUrl}`]);
  await pool.query(
    `INSERT INTO session_events (session_id, event_type, payload)
     VALUES ($1, 'handoff_offered', '{"tier": 4}')`,
    [sessionId],
  );
}

const ALERT_TTL_MINUTES = 10;

/** Creates the counsellor alert (one active per session) and notifies APIs. */
export async function raiseAlert(
  pool: Pool,
  sessionId: string,
  tier: "orange" | "red",
): Promise<string | null> {
  const { rows } = await pool.query(
    `INSERT INTO alerts (session_id, tier, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))
     ON CONFLICT (session_id) WHERE status = 'active' DO NOTHING
     RETURNING id`,
    [sessionId, tier, ALERT_TTL_MINUTES],
  );
  const alertId = rows[0] ? String(rows[0].id) : null;
  if (alertId) {
    await pool.query("SELECT pg_notify('zenith_alert_new', $1)", [alertId]);
  }
  return alertId;
}

/** Expires stale alerts (user vanished / nobody accepted) — PRD edge case. */
export async function expireStaleAlerts(pool: Pool): Promise<number> {
  const { rows } = await pool.query(
    `UPDATE alerts SET status = 'expired'
     WHERE status = 'active' AND expires_at <= now()
     RETURNING id`,
  );
  for (const row of rows) {
    await pool.query("SELECT pg_notify('zenith_alert_expired', $1)", [String(row.id)]);
  }
  return rows.length;
}

// PRD Flow B step 6: RED tier with no counsellor accepting within 90 seconds —
// the buddy quietly surfaces real numbers inline. A suggestion, never a banner.
const RED_FALLBACK_TEXT =
  "If you feel like talking to a real person right now, iCall has kind, trained counsellors at +91-9152987821 — it's free and they won't ask who you are. There's also 7cups.com/talk-to-someone-now if typing feels easier. I'm right here with you either way.";

export const RED_FALLBACK_DELAY_SECONDS = 90;

/**
 * Runs 90s after a RED alert: if nobody accepted it, deliver the helpline
 * fallback in the buddy's voice. The API broadcasts it to the user's tabs
 * via the zenith_user_message channel.
 */
export async function deliverRedFallback(pool: Pool, alertId: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT session_id FROM alerts WHERE id = $1 AND status = 'active'",
    [alertId],
  );
  const sessionId: string | undefined = rows[0]?.session_id;
  if (!sessionId) return false; // accepted or expired — a human got there first

  const inserted = await pool.query(
    `INSERT INTO session_messages (session_id, sender, content)
     SELECT $1, 'buddy', $2
     WHERE EXISTS (SELECT 1 FROM sessions WHERE id = $1 AND status IN ('active','escalation_pending'))
     RETURNING id`,
    [sessionId, RED_FALLBACK_TEXT],
  );
  if (!inserted.rows[0]) return false;

  await pool.query("SELECT pg_notify('zenith_user_message', $1)", [
    `${sessionId}:${inserted.rows[0].id}`,
  ]);
  await pool.query(
    `INSERT INTO session_events (session_id, event_type, payload)
     VALUES ($1, 'red_fallback_delivered', '{}')`,
    [sessionId],
  );
  return true;
}
