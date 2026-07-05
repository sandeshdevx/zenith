/**
 * Phase 5 exit criteria (ROADMAP §2, Phase 5):
 *  - two counsellors racing to accept one alert → exactly one wins
 *  - alert payloads carry only {sessionId, tier, lastTurns} — no PII
 *  - magic-link + TOTP auth flow; alert expiry
 * Requires PostgreSQL with migrations applied; skips otherwise.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { currentTotp, generateTotpSecret } from "../src/auth/totp.js";
import { signCounsellorToken } from "../src/auth/counsellorToken.js";

const config = loadConfig();
let pool: Pool;
let app: ReturnType<typeof buildServer>;
let dbAvailable = false;

before(async () => {
  pool = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 2000, max: 5 });
  pool.on("error", () => {});
  try {
    await pool.query("SELECT 1 FROM alerts LIMIT 1");
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

async function seedCounsellor(email: string): Promise<string> {
  const { rows } = await pool.query(
    "INSERT INTO counsellors (email, display_name) VALUES ($1, $2) RETURNING id",
    [email, "Test Counsellor"],
  );
  return rows[0].id;
}

async function seedAlertedSession(): Promise<string> {
  const sessionId = randomUUID();
  await pool.query("INSERT INTO sessions (id, status, mode, risk_tier) VALUES ($1, 'active', 'text', 'red')", [sessionId]);
  for (const content of ["first turn", "second turn", "third turn", "fourth turn"]) {
    await pool.query(
      "INSERT INTO session_messages (session_id, sender, content) VALUES ($1, 'user', $2)",
      [sessionId, content],
    );
  }
  await pool.query(
    "INSERT INTO alerts (session_id, tier, expires_at) VALUES ($1, 'red', now() + interval '10 minutes')",
    [sessionId],
  );
  return sessionId;
}

test("magic link login: request, verify, cookie session", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const email = `c-${randomUUID().slice(0, 8)}@test.zenith`;
  const counsellorId = await seedCounsellor(email);

  const requested = await app.inject({
    method: "POST",
    url: "/api/v1/counsellor/login",
    payload: { email },
  });
  assert.equal(requested.statusCode, 200);

  // The token is logged, not returned; for the test, mint one directly the
  // same way the service does and verify through the public endpoint.
  const rawToken = "test-token-" + randomUUID();
  await pool.query(
    "INSERT INTO login_tokens (token_hash, counsellor_id, expires_at) VALUES ($1, $2, now() + interval '15 minutes')",
    [createHash("sha256").update(rawToken).digest("hex"), counsellorId],
  );

  const verified = await app.inject({
    method: "POST",
    url: "/api/v1/counsellor/verify",
    payload: { token: rawToken },
  });
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.json().role, "counsellor");
  assert.ok(verified.json().token);

  // Single-use: the same link cannot be replayed.
  const replayed = await app.inject({
    method: "POST",
    url: "/api/v1/counsellor/verify",
    payload: { token: rawToken },
  });
  assert.equal(replayed.statusCode, 401);

  await pool.query("DELETE FROM counsellors WHERE id = $1", [counsellorId]);
});

test("TOTP-enrolled account requires a valid code", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const email = `c-${randomUUID().slice(0, 8)}@test.zenith`;
  const counsellorId = await seedCounsellor(email);
  const secret = generateTotpSecret();
  await pool.query("UPDATE counsellors SET totp_secret = $2 WHERE id = $1", [counsellorId, secret]);

  const rawToken = "test-token-" + randomUUID();
  await pool.query(
    "INSERT INTO login_tokens (token_hash, counsellor_id, expires_at) VALUES ($1, $2, now() + interval '15 minutes')",
    [createHash("sha256").update(rawToken).digest("hex"), counsellorId],
  );

  const noCode = await app.inject({
    method: "POST",
    url: "/api/v1/counsellor/verify",
    payload: { token: rawToken },
  });
  assert.equal(noCode.statusCode, 401);
  assert.equal(noCode.json().totpRequired, true);

  const withCode = await app.inject({
    method: "POST",
    url: "/api/v1/counsellor/verify",
    payload: { token: rawToken, totpCode: currentTotp(secret) },
  });
  assert.equal(withCode.statusCode, 200);

  await pool.query("DELETE FROM counsellors WHERE id = $1", [counsellorId]);
});

test("queue payload is whitelist-only: uuid, tier, last 3 turns", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const counsellorId = await seedCounsellor(`c-${randomUUID().slice(0, 8)}@test.zenith`);
  const sessionId = await seedAlertedSession();
  const token = signCounsellorToken(counsellorId, "counsellor", config.SESSION_TOKEN_SECRET);

  const res = await app.inject({
    method: "GET",
    url: "/api/v1/counsellor/queue",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const alert = res.json().alerts.find((a: { sessionId: string }) => a.sessionId === sessionId);
  assert.ok(alert, "seeded alert appears in queue");
  assert.equal(alert.tier, "red");
  assert.equal(alert.lastTurns.length, 3, "exactly the last 3 turns");
  assert.equal(alert.lastTurns[0].content, "second turn");
  assert.deepEqual(
    Object.keys(alert).sort(),
    ["alertId", "createdAt", "expiresAt", "lastTurns", "sessionId", "tier"],
    "no extra fields can cross to the counsellor plane",
  );

  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
  await pool.query("DELETE FROM counsellors WHERE id = $1", [counsellorId]);
});

test("two counsellors race to accept: exactly one wins", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const c1 = await seedCounsellor(`c1-${randomUUID().slice(0, 8)}@test.zenith`);
  const c2 = await seedCounsellor(`c2-${randomUUID().slice(0, 8)}@test.zenith`);
  const sessionId = await seedAlertedSession();
  const t1 = signCounsellorToken(c1, "counsellor", config.SESSION_TOKEN_SECRET);
  const t2 = signCounsellorToken(c2, "counsellor", config.SESSION_TOKEN_SECRET);

  const accept = (token: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/counsellor/sessions/${sessionId}/accept`,
      headers: { authorization: `Bearer ${token}` },
    });
  const [r1, r2] = await Promise.all([accept(t1), accept(t2)]);
  const statuses = [r1.statusCode, r2.statusCode].sort();
  assert.deepEqual(statuses, [200, 409], "one 200, one 409 — never two winners");

  const session = await pool.query("SELECT status, counsellor_id FROM sessions WHERE id = $1", [sessionId]);
  assert.equal(session.rows[0].status, "escalation_pending");
  assert.ok(session.rows[0].counsellor_id);

  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
  await pool.query("DELETE FROM counsellors WHERE id IN ($1, $2)", [c1, c2]);
});

test("expired alerts vanish from the queue", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const counsellorId = await seedCounsellor(`c-${randomUUID().slice(0, 8)}@test.zenith`);
  const sessionId = randomUUID();
  await pool.query("INSERT INTO sessions (id, status, mode) VALUES ($1, 'active', 'text')", [sessionId]);
  await pool.query(
    "INSERT INTO alerts (session_id, tier, expires_at) VALUES ($1, 'orange', now() - interval '1 minute')",
    [sessionId],
  );
  const token = signCounsellorToken(counsellorId, "counsellor", config.SESSION_TOKEN_SECRET);
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/counsellor/queue",
    headers: { authorization: `Bearer ${token}` },
  });
  const found = res.json().alerts.some((a: { sessionId: string }) => a.sessionId === sessionId);
  assert.equal(found, false);

  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
  await pool.query("DELETE FROM counsellors WHERE id = $1", [counsellorId]);
});
