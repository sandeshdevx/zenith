/**
 * OpenAICompatLlmAdapter: SSE stream parsing against a local mock server —
 * no network, no API key, verifies Groq/Gemini/OpenRouter compatibility shape.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { OpenAICompatLlmAdapter } from "@zenith/adapters";

let server: Server;
let baseUrl: string;
let lastAuth: string | undefined;

before(async () => {
  server = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunks = ["That ", "sounds ", "really hard."];
      for (const content of chunks) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
});

after(() => server.close());

test("streams SSE deltas and returns the full text", async () => {
  const adapter = new OpenAICompatLlmAdapter({
    baseUrl,
    apiKey: "test-key",
    model: "mock-model",
  });
  const fragments: string[] = [];
  const full = await adapter.chatStream(
    [{ role: "user", content: "hello" }],
    { onToken: (f) => fragments.push(f) },
  );
  assert.equal(full, "That sounds really hard.");
  assert.deepEqual(fragments, ["That ", "sounds ", "really hard."]);
  assert.equal(lastAuth, "Bearer test-key", "api key sent as bearer");
});

test("healthCheck hits /models with auth", async () => {
  const adapter = new OpenAICompatLlmAdapter({ baseUrl, apiKey: "k", model: "mock-model" });
  assert.equal(await adapter.healthCheck(), true);
  const dead = new OpenAICompatLlmAdapter({ baseUrl: "http://127.0.0.1:9", model: "x" });
  assert.equal(await dead.healthCheck(), false);
});
