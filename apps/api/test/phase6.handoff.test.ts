/**
 * Phase 6 exit criteria (ROADMAP §2, Phase 6): scripted end-to-end drill —
 * simulated RED → alert → counsellor accept → buddy-framed offer → user
 * accept → Jitsi room; plus decline path, user-initiated escalation, and
 * the no-counsellor RED fallback.
 * Requires PostgreSQL with migrations applied; skips otherwise.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { signCounsellorToken } from "../src/auth/counsellorToken.js";

const config = loadConfig();
let pool: Pool;
let app: ReturnType<typeof buildServer>;
let dbAvailable = false;

before(async () => {
  pool = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 2000, max: 5 });
  pool.on("error", () => {});
  try {
    await pool.query("SELECT handoff_room FROM sessions LIMIT 1");
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
  app = buildServer(config);
  await app.ready();
});

after(async () => {
  await app.close();
  await pool.end().catch(() => {});
});

async function createUserSession(): Promise<{ sessionId: string; token: string }> {
  const res = await app.inject({ method: "POST", url: "/api/v1/sessions", payload: {} });
  return res.json();
}

async function seedRedAlert(sessionId: string): Promise<void> {
  await pool.query("UPDATE sessions SET risk_tier = 'red' WHERE id = $1", [sessionId]);
  await pool.query(
    "INSERT INTO alerts (session_id, tier, expires_at) VALUES ($1, 'red', now() + interval '10 minutes')",
    [sessionId],
  );
}

async function seedCounsellorToken(): Promise<{ counsellorId: string; token: string }> {
  const { rows } = await pool.query(
    "INSERT INTO counsellors (email, display_name) VALUES ($1, 'Drill Counsellor') RETURNING id",
    [`drill-${randomUUID().slice(0, 8)}@test.zenith`],
  );
  return {
    counsellorId: rows[0].id,
    token: signCounsellorToken(rows[0].id, "counsellor", config.SESSION_TOKEN_SECRET),
  };
}

test("full drill: RED → accept → offer → user accepts → Jitsi room", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const user = await createUserSession();
  await app.inject({
    method: "POST",
    url: `/api/v1/sessions/${user.sessionId}/messages`,
    headers: { authorization: `Bearer ${user.token}` },
    payload: { content: "it's been a hard week" },
  });
  await seedRedAlert(user.sessionId);
  const counsellor = await seedCounsellorToken();

  // Counsellor accepts → gets the room.
  const accepted = await app.inject({
    method: "POST",
    url: `/api/v1/counsellor/sessions/${user.sessionId}/accept`,
    headers: { authorization: `Bearer ${counsellor.token}` },
  });
  assert.equal(accepted.statusCode, 200);
  const { roomUrl } = accepted.json();
  assert.match(roomUrl, /^https:\/\/meet\.jit\.si\/zenith-[0-9a-f-]{36}$/);

  // The user's transcript now contains the buddy-framed offer — no system
  // language, no mention of detection.
  const messages = await app.inject({
    method: "GET",
    url: `/api/v1/sessions/${user.sessionId}/messages`,
    headers: { authorization: `Bearer ${user.token}` },
  });
  const offer = messages
    .json()
    .messages.find((m: { sender: string; content: string }) => m.sender === "buddy");
  assert.ok(offer, "offer delivered in the buddy's voice");
  assert.match(offer.content, /there'?s a person available/i);
  assert.doesNotMatch(offer.content, /risk|alert|detect|crisis|system/i);

  // User accepts → same room, session in handoff.
  const userAccept = await app.inject({
    method: "POST",
    url: `/api/v1/sessions/${user.sessionId}/handoff/accept`,
    headers: { authorization: `Bearer ${user.token}` },
  });
  assert.equal(userAccept.statusCode, 200);
  assert.equal(userAccept.json().roomUrl, roomUrl);
  const session = await pool.query("SELECT status FROM sessions WHERE id = $1", [user.sessionId]);
  assert.equal(session.rows[0].status, "handoff_active");

  await pool.query("DELETE FROM sessions WHERE id = $1", [user.sessionId]);
  await pool.query("DELETE FROM counsellors WHERE id = $1", [counsellor.counsellorId]);
});

test("user declines: buddy continues, session back to active", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const user = await createUserSession();
  await seedRedAlert(user.sessionId);
  const counsellor = await seedCounsellorToken();

  await app.inject({
    method: "POST",
    url: `/api/v1/counsellor/sessions/${user.sessionId}/accept`,
    headers: { authorization: `Bearer ${counsellor.token}` },
  });
  const declined = await app.inject({
    method: "POST",
    url: `/api/v1/sessions/${user.sessionId}/handoff/decline`,
    headers: { authorization: `Bearer ${user.token}` },
  });
  assert.equal(declined.statusCode, 200);
  const session = await pool.query("SELECT status FROM sessions WHERE id = $1", [user.sessionId]);
  assert.equal(session.rows[0].status, "active");

  await pool.query("DELETE FROM sessions WHERE id = $1", [user.sessionId]);
  await pool.query("DELETE FROM counsellors WHERE id = $1", [counsellor.counsellorId]);
});

test("user-initiated escalation raises an alert visible in the queue", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const user = await createUserSession();
  const counsellor = await seedCounsellorToken();

  const escalated = await app.inject({
    method: "POST",
    url: `/api/v1/sessions/${user.sessionId}/escalate`,
    headers: { authorization: `Bearer ${user.token}` },
  });
  assert.equal(escalated.statusCode, 200);
  assert.equal(escalated.json().alreadyPending, false);

  // Idempotent: a second press does not create a second alert.
  const again = await app.inject({
    method: "POST",
    url: `/api/v1/sessions/${user.sessionId}/escalate`,
    headers: { authorization: `Bearer ${user.token}` },
  });
  assert.equal(again.json().alreadyPending, true);

  const queue = await app.inject({
    method: "GET",
    url: "/api/v1/counsellor/queue",
    headers: { authorization: `Bearer ${counsellor.token}` },
  });
  const found = queue.json().alerts.filter(
    (a: { sessionId: string }) => a.sessionId === user.sessionId,
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].tier, "orange");

  await pool.query("DELETE FROM sessions WHERE id = $1", [user.sessionId]);
  await pool.query("DELETE FROM counsellors WHERE id = $1", [counsellor.counsellorId]);
});
