/**
 * Phase 3 exit criteria (ROADMAP §2, Phase 3):
 *  - full anonymous text conversation: user message → streamed buddy reply
 *  - graceful degradation when the model is unavailable (human options, not silence)
 *
 * Requires PostgreSQL; the live-generation test additionally requires Ollama
 * with the configured model and is skipped when absent. CPU inference is
 * slow — generous timeouts are intentional.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { Pool } from "pg";
import { OllamaLlmAdapter, type LlmAdapter } from "@zenith/adapters";
import type { WsServerFrame } from "@zenith/contracts";
import { loadConfig } from "../src/config.js";
import { buildServer, type ServerOptions } from "../src/server.js";
import { createBuddyService, type BuddyService } from "../src/services/buddy.js";

// tsx loads .env? No — mirror index.ts behavior: config comes from process.env.
const config = loadConfig();
let pool: Pool;
let app: ReturnType<typeof buildServer>;
let buddy: BuddyService;
let wsUrl: string;
let baseUrl: string;
let dbAvailable = false;
let llmAvailable = false;

const adapter = new OllamaLlmAdapter({
  baseUrl: config.OLLAMA_URL,
  model: config.OLLAMA_MODEL,
  numPredict: 60,
  timeoutMs: 180_000,
});

before(async () => {
  pool = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 2000, max: 3 });
  pool.on("error", () => {});
  try {
    await pool.query("SELECT 1 FROM sessions LIMIT 1");
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }

  // Model must exist locally, not just the Ollama daemon.
  try {
    const res = await fetch(`${config.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const tags = (await res.json()) as { models?: { name: string }[] };
    llmAvailable = !!tags.models?.some((m) => m.name === config.OLLAMA_MODEL);
  } catch {
    llmAvailable = false;
  }

  let onUserMessage: ServerOptions["onUserMessage"];
  app = buildServer(config, { onUserMessage: (sid, c) => onUserMessage?.(sid, c) });
  buddy = createBuddyService(pool, adapter, app.log, 60_000);
  onUserMessage = buddy.onUserMessage;

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/api/v1/ws`;
});

after(async () => {
  buddy.stop();
  await app.close();
  await pool.end().catch(() => {});
});

async function createSession(): Promise<{ sessionId: string; token: string }> {
  const res = await fetch(`${baseUrl}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return (await res.json()) as { sessionId: string; token: string };
}

function connectAndAuth(token: string): Promise<{ ws: WebSocket; frames: WsServerFrame[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const frames: WsServerFrame[] = [];
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as WsServerFrame;
      frames.push(frame);
      if (frame.type === "auth.ok") resolve({ ws, frames });
    });
    ws.on("error", reject);
  });
}

function waitFor(
  frames: WsServerFrame[],
  predicate: (f: WsServerFrame) => boolean,
  timeoutMs: number,
): Promise<WsServerFrame> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = frames.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for frame"));
      setTimeout(tick, 100);
    };
    tick();
  });
}

test("support options endpoint lists free human help", async () => {
  const res = await fetch(`${baseUrl}/api/v1/support-options`);
  assert.equal(res.status, 200);
  const { options } = (await res.json()) as { options: { id: string; available: boolean }[] };
  assert.ok(options.length >= 4);
  assert.ok(options.some((o) => o.id === "icall"));
  assert.ok(options.some((o) => o.id === "sevencups"));
});

test("user message gets a streamed buddy reply over WS", { timeout: 200_000 }, async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  if (!llmAvailable) return t.skip(`model ${config.OLLAMA_MODEL} not available in Ollama`);

  const { sessionId, token } = await createSession();
  const { ws, frames } = await connectAndAuth(token);

  ws.send(JSON.stringify({ type: "message", content: "I had a really rough day and I can't sleep." }));
  await waitFor(frames, (f) => f.type === "message.received", 10_000);

  // Streaming fragments arrive first, then the completed persisted message.
  const sent = await waitFor(frames, (f) => f.type === "message.sent" && f.sender === "buddy", 180_000);
  assert.ok(sent.type === "message.sent" && sent.content.length > 0);
  assert.ok(
    frames.some((f) => f.type === "message.delta"),
    "reply must be streamed as deltas before completion",
  );

  // The buddy reply is persisted — reconnect context includes it.
  const res = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/messages`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { messages } = (await res.json()) as { messages: { sender: string }[] };
  assert.ok(messages.some((m) => m.sender === "buddy"));

  ws.close();
  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
});

test("model outage degrades to human options, never silence", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");

  const deadAdapter: LlmAdapter = {
    name: "dead",
    healthCheck: async () => false,
    chatStream: async () => {
      throw new Error("model down");
    },
  };
  const deadBuddy = createBuddyService(pool, deadAdapter, app.log, 60_000);
  t.after(() => deadBuddy.stop());
  // Let the initial health check resolve.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(deadBuddy.isAvailable(), false);

  const { sessionId, token } = await createSession();
  const { ws, frames } = await connectAndAuth(token);

  // Route this session's messages to the dead buddy directly.
  deadBuddy.onUserMessage(sessionId, "hello?");
  const sent = await waitFor(frames, (f) => f.type === "message.sent" && f.sender === "buddy", 10_000);
  assert.ok(sent.type === "message.sent");
  assert.match(sent.content, /talk to a real person/i);

  ws.close();
  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
});
