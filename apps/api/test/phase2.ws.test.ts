/**
 * Phase 2 exit criteria (ROADMAP §2, Phase 2):
 *  - WS upgrade requires first-frame auth
 *  - kill the socket mid-conversation → client recovers with no message loss
 *    (reconnect + REST re-fetch returns everything)
 *
 * Requires a running PostgreSQL with migrations applied; skips otherwise.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { Pool } from "pg";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import type { WsServerFrame } from "@zenith/contracts";

const config = loadConfig();
let pool: Pool;
let app: ReturnType<typeof buildServer>;
let baseUrl: string;
let wsUrl: string;
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
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/api/v1/ws`;
});

after(async () => {
  await app.close();
  await pool.end().catch(() => {});
});

function connectAndAuth(token: string): Promise<{ ws: WebSocket; frames: WsServerFrame[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const frames: WsServerFrame[] = [];
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as WsServerFrame;
      frames.push(frame);
      if (frame.type === "auth.ok") resolve({ ws, frames });
      if (frame.type === "auth.error") reject(new Error(frame.reason));
    });
    ws.on("error", reject);
  });
}

function waitForFrame(frames: WsServerFrame[], type: WsServerFrame["type"], timeoutMs = 5000): Promise<WsServerFrame> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = frames.find((f) => f.type === type);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) return reject(new Error(`no ${type} frame within ${timeoutMs}ms`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("unauthenticated frames are rejected and socket closes", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const closed = new Promise<number>((resolve) => {
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => ws.send(JSON.stringify({ type: "message", content: "hi" })));
    ws.on("close", (code) => resolve(code));
  });
  assert.equal(await closed, 4401);
});

test("socket drop mid-conversation loses no messages", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");

  const created = await fetch(`${baseUrl}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const { sessionId, token } = (await created.json()) as { sessionId: string; token: string };

  // First connection: send a message, get the persistence ack.
  const first = await connectAndAuth(token);
  first.ws.send(JSON.stringify({ type: "message", content: "first message before the drop" }));
  await waitForFrame(first.frames, "message.received");

  // Simulate a network drop: terminate without a close handshake.
  first.ws.terminate();

  // Reconnect: new socket, same token.
  const second = await connectAndAuth(token);
  second.ws.send(JSON.stringify({ type: "message", content: "second message after reconnect" }));
  await waitForFrame(second.frames, "message.received");

  // REST re-fetch is the recovery path — both messages must be there.
  const res = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/messages`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { messages } = (await res.json()) as { messages: { content: string }[] };
  const contents = messages.map((m) => m.content);
  assert.ok(contents.includes("first message before the drop"), "message from before the drop survived");
  assert.ok(contents.includes("second message after reconnect"), "message after reconnect persisted");

  second.ws.close();
  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
});

test("multiple tabs of one session all receive broadcasts", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");

  const created = await fetch(`${baseUrl}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const { sessionId, token } = (await created.json()) as { sessionId: string; token: string };

  const tabA = await connectAndAuth(token);
  const tabB = await connectAndAuth(token);

  tabA.ws.send(JSON.stringify({ type: "message", content: "hello from tab A" }));
  await waitForFrame(tabA.frames, "message.received");
  await waitForFrame(tabB.frames, "message.received");

  tabA.ws.close();
  tabB.ws.close();
  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
});
