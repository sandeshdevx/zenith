/**
 * Risk scoring consumer (Phase 4, PRD Flow B).
 * Jobs carry IDs only — content is read from the DB at scoring time and the
 * stored assessment holds pattern IDs, never text.
 *
 * Escalation rule (PRD false-positive control): a session becomes
 * alert-eligible at ORANGE/RED only when 2 of its last 3 assessments are
 * ORANGE/RED. Tiers never downgrade within a session (safety is sticky).
 */
import type { Pool } from "pg";
import { RISK_TIER_RANK, type RiskAdapter, type RiskTier } from "@zenith/adapters";

export interface ScoreJob {
  sessionId: string;
  messageId: string;
}

export interface ScoreOutcome {
  tier: RiskTier;
  sessionTier: RiskTier;
  alertEligible: boolean;
  /** Set when a new alert row was created by this scoring pass. */
  raisedAlertId?: string;
}

export async function scoreMessage(
  pool: Pool,
  adapters: RiskAdapter[],
  job: ScoreJob,
): Promise<ScoreOutcome | null> {
  const { rows } = await pool.query(
    "SELECT content FROM session_messages WHERE id = $1 AND session_id = $2 AND sender = 'user'",
    [job.messageId, job.sessionId],
  );
  const content: string | undefined = rows[0]?.content;
  if (content === undefined) return null; // purged or ended — nothing to do

  // Highest tier across adapters wins (sentinel floor + future model).
  let tier: RiskTier = "green";
  let score = 0;
  const signals: string[] = [];
  const sources: string[] = [];
  for (const adapter of adapters) {
    const a = await adapter.assess(content);
    sources.push(adapter.name);
    signals.push(...a.signals);
    if (RISK_TIER_RANK[a.tier] > RISK_TIER_RANK[tier]) {
      tier = a.tier;
      score = a.score;
    }
  }

  await pool.query(
    `INSERT INTO risk_assessments (session_id, message_id, tier, score, source, signals)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [job.sessionId, job.messageId, tier, score, sources.join("+"), JSON.stringify(signals)],
  );

  return applyEscalation(pool, job.sessionId, tier);
}

async function applyEscalation(
  pool: Pool,
  sessionId: string,
  latest: RiskTier,
): Promise<ScoreOutcome> {
  const current = await pool.query("SELECT risk_tier FROM sessions WHERE id = $1", [sessionId]);
  const currentTier: RiskTier = current.rows[0]?.risk_tier ?? "green";

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
    target = "yellow";
  }

  let raisedAlertId: string | undefined;
  if (target !== currentTier) {
    await pool.query("UPDATE sessions SET risk_tier = $2 WHERE id = $1", [sessionId, target]);
    if (alertEligible) {
      await pool.query(
        `INSERT INTO session_events (session_id, event_type, payload)
         VALUES ($1, 'risk_alert_eligible', $2)`,
        [sessionId, JSON.stringify({ tier: target })],
      );
      raisedAlertId = (await raiseAlert(pool, sessionId, target as "orange" | "red")) ?? undefined;
    }
  }

  return { tier: latest, sessionTier: target, alertEligible, raisedAlertId };
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
