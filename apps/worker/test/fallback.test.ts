/**
 * Phase 6: RED fallback — fires only when nobody accepted within the window.
 * Requires PostgreSQL with migrations applied; skips otherwise.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { deliverRedFallback } from "../src/risk.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://zenith:zenith@localhost:5432/zenith",
  connectionTimeoutMillis: 2000,
  max: 3,
});
pool.on("error", () => {});
let dbAvailable = false;

before(async () => {
  try {
    await pool.query("SELECT 1 FROM alerts LIMIT 1");
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  await pool.end().catch(() => {});
});

async function seedSessionWithAlert(status: "active" | "accepted"): Promise<{ sessionId: string; alertId: string }> {
  const sessionId = randomUUID();
  await pool.query("INSERT INTO sessions (id, status, mode, risk_tier) VALUES ($1, 'active', 'text', 'red')", [sessionId]);
  const { rows } = await pool.query(
    "INSERT INTO alerts (session_id, tier, status, expires_at) VALUES ($1, 'red', $2, now() + interval '10 minutes') RETURNING id",
    [sessionId, status],
  );
  return { sessionId, alertId: String(rows[0].id) };
}

test("unaccepted RED alert delivers helpline fallback in buddy voice", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const { sessionId, alertId } = await seedSessionWithAlert("active");

  const delivered = await deliverRedFallback(pool, alertId);
  assert.equal(delivered, true);

  const messages = await pool.query(
    "SELECT sender, content FROM session_messages WHERE session_id = $1",
    [sessionId],
  );
  assert.equal(messages.rows.length, 1);
  assert.equal(messages.rows[0].sender, "buddy");
  assert.match(messages.rows[0].content, /9152987821/);
  assert.match(messages.rows[0].content, /7cups/i);
  // A suggestion, never system language.
  assert.doesNotMatch(messages.rows[0].content, /risk|alert|crisis|detect|emergency/i);

  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
});

test("accepted alert suppresses the fallback — a human got there", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const { sessionId, alertId } = await seedSessionWithAlert("accepted");

  const delivered = await deliverRedFallback(pool, alertId);
  assert.equal(delivered, false);

  const messages = await pool.query(
    "SELECT 1 FROM session_messages WHERE session_id = $1",
    [sessionId],
  );
  assert.equal(messages.rowCount, 0);

  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
});
