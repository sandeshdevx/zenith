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

  if (target !== currentTier) {
    await pool.query("UPDATE sessions SET risk_tier = $2 WHERE id = $1", [sessionId, target]);
    if (alertEligible) {
      // Phase 5 dispatches counsellor alerts from this event. Payload carries
      // tier only — no content, no PII.
      await pool.query(
        `INSERT INTO session_events (session_id, event_type, payload)
         VALUES ($1, 'risk_alert_eligible', $2)`,
        [sessionId, JSON.stringify({ tier: target })],
      );
    }
  }

  return { tier: latest, sessionTier: target, alertEligible };
}
