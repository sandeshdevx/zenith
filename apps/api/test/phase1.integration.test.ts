/**
 * Phase 1 exit criteria (ROADMAP §2, Phase 1):
 *  - token auth is enforced on every session route
 *  - a session's data is provably gone after the purge pass
 *
 * Requires a running PostgreSQL with migrations applied; skips otherwise.
 * Run: npm run test -w @zenith/api
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

const config = loadConfig();
let pool: Pool;
let app: ReturnType<typeof buildServer>;
let dbAvailable = false;

before(async () => {
  pool = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 2000, max: 3 });
  pool.on("error", () => {});
  try {
    await pool.query("SELECT 1 FROM sessions LIMIT 1");
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

test("session lifecycle: create → message → purge leaves no trace", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const created = await app.inject({ method: "POST", url: "/api/v1/sessions", payload: {} });
  assert.equal(created.statusCode, 201);
  const { sessionId, token } = created.json();
  assert.ok(sessionId && token);

  const auth = { authorization: `Bearer ${token}` };

  const msg = await app.inject({
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/messages`,
    headers: auth,
    payload: { content: "hello from the integration test" },
  });
  assert.equal(msg.statusCode, 201);

  const ended = await app.inject({
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/end`,
    headers: auth,
  });
  assert.equal(ended.statusCode, 200);

  // Run the same purge the worker runs.
  await pool.query(
    `DELETE FROM sessions
     WHERE status = 'ended' OR last_active_at < now() - make_interval(mins => 10)`,
  );

  const sessions = await pool.query("SELECT 1 FROM sessions WHERE id = $1", [sessionId]);
  assert.equal(sessions.rowCount, 0, "session row must be purged");
  const messages = await pool.query("SELECT 1 FROM session_messages WHERE session_id = $1", [sessionId]);
  assert.equal(messages.rowCount, 0, "message rows must cascade-delete");
  const events = await pool.query("SELECT 1 FROM session_events WHERE session_id = $1", [sessionId]);
  assert.equal(events.rowCount, 0, "event rows must cascade-delete");
});

test("all session routes reject missing/invalid tokens", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const created = await app.inject({ method: "POST", url: "/api/v1/sessions", payload: {} });
  const { sessionId } = created.json();

  for (const route of [
    { method: "GET" as const, url: `/api/v1/sessions/${sessionId}` },
    { method: "POST" as const, url: `/api/v1/sessions/${sessionId}/messages`, payload: { content: "x" } },
    { method: "POST" as const, url: `/api/v1/sessions/${sessionId}/end` },
  ]) {
    const noToken = await app.inject(route);
    assert.equal(noToken.statusCode, 401, `${route.url} without token`);
    const badToken = await app.inject({
      ...route,
      headers: { authorization: "Bearer not.a-real-token" },
    });
    assert.equal(badToken.statusCode, 401, `${route.url} with invalid token`);
  }

  // A token for session A must not open session B.
  const other = await app.inject({ method: "POST", url: "/api/v1/sessions", payload: {} });
  const otherToken = other.json().token;
  const crossSession = await app.inject({
    method: "GET",
    url: `/api/v1/sessions/${sessionId}`,
    headers: { authorization: `Bearer ${otherToken}` },
  });
  assert.equal(crossSession.statusCode, 401, "cross-session token must be rejected");

  // Cleanup: purge what this test created.
  await pool.query("DELETE FROM sessions WHERE id = ANY($1::uuid[])", [[sessionId, other.json().sessionId]]);
});

test("user-facing session response never exposes risk tier", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const created = await app.inject({ method: "POST", url: "/api/v1/sessions", payload: {} });
  const { sessionId, token } = created.json();

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/sessions/${sessionId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const text = res.body.toLowerCase();
  assert.ok(!text.includes("risk"), "risk data must never appear on user-facing surfaces");

  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
});
