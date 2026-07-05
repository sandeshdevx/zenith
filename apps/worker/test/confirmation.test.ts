/**
 * Phase 4 exit criteria: replay a transcript through the scoring path and
 * verify tier transitions honour the PRD's 2-of-last-3-turns confirmation
 * window, tier stickiness, and the alert-eligibility event.
 * Requires PostgreSQL with migrations applied; skips otherwise.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { KeywordSentinelAdapter } from "@zenith/adapters";
import { scoreMessage } from "../src/risk.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://zenith:zenith@localhost:5432/zenith",
  connectionTimeoutMillis: 2000,
  max: 3,
});
pool.on("error", () => {});

let dbAvailable = false;
const adapters = [new KeywordSentinelAdapter()];

before(async () => {
  try {
    await pool.query("SELECT 1 FROM risk_assessments LIMIT 1");
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  await pool.end().catch(() => {});
});

async function newSession(): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO sessions (id, status, mode) VALUES ($1, 'active', 'text')", [id]);
  return id;
}

async function addUserMessage(sessionId: string, content: string): Promise<string> {
  const { rows } = await pool.query(
    "INSERT INTO session_messages (session_id, sender, content) VALUES ($1, 'user', $2) RETURNING id",
    [sessionId, content],
  );
  return String(rows[0].id);
}

async function replay(sessionId: string, content: string) {
  const messageId = await addUserMessage(sessionId, content);
  return scoreMessage(pool, adapters, { sessionId, messageId });
}

test("single RED turn does not fire an alert; 2-of-3 does", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const sessionId = await newSession();

  // Turn 1: red — but only 1 of last 3 → no alert (false-positive control).
  const first = await replay(sessionId, "I want to die");
  assert.equal(first?.tier, "red");
  assert.equal(first?.alertEligible, false);
  assert.equal(first?.sessionTier, "green");

  // Turn 2: green filler → still no alert.
  const second = await replay(sessionId, "sorry, ignore that");
  assert.equal(second?.alertEligible, false);

  // Turn 3: red again → 2 of last 3 are high → alert fires.
  const third = await replay(sessionId, "no really, I keep thinking about suicide");
  assert.equal(third?.tier, "red");
  assert.equal(third?.alertEligible, true);
  assert.equal(third?.sessionTier, "red");

  const events = await pool.query(
    "SELECT payload FROM session_events WHERE session_id = $1 AND event_type = 'risk_alert_eligible'",
    [sessionId],
  );
  assert.equal(events.rowCount, 1);
  assert.equal(events.rows[0].payload.tier, "red");

  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
});

test("tier never downgrades after confirmation", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const sessionId = await newSession();

  await replay(sessionId, "there is no reason to live");
  await replay(sessionId, "I've been hurting myself");
  const confirmed = await pool.query("SELECT risk_tier FROM sessions WHERE id = $1", [sessionId]);
  assert.equal(confirmed.rows[0].risk_tier, "orange");

  // Calm turns afterwards must not lower the session tier.
  await replay(sessionId, "anyway how is the weather");
  await replay(sessionId, "I like cricket");
  const after1 = await pool.query("SELECT risk_tier FROM sessions WHERE id = $1", [sessionId]);
  assert.equal(after1.rows[0].risk_tier, "orange");

  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
});

test("scoring a purged message is a silent no-op", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const sessionId = await newSession();
  const messageId = await addUserMessage(sessionId, "I want to die");
  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]); // purge cascades

  const outcome = await scoreMessage(pool, adapters, { sessionId, messageId });
  assert.equal(outcome, null);
});

test("assessment rows never contain message content", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const sessionId = await newSession();
  await replay(sessionId, "I want to die tonight honestly");

  const { rows } = await pool.query(
    "SELECT tier, source, signals::text AS signals FROM risk_assessments WHERE session_id = $1",
    [sessionId],
  );
  assert.equal(rows.length, 1);
  // Signals hold static pattern ids; words unique to the user's message
  // must never appear in the stored assessment.
  assert.ok(!rows[0].signals.toLowerCase().includes("tonight"), "no content in signals");
  assert.ok(!rows[0].signals.toLowerCase().includes("honestly"), "no content in signals");

  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
});
