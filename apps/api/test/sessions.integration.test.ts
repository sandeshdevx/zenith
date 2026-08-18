import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { Pool } from "pg";
import { loadConfig } from "../src/config.js";
import { persistMessage, listRecentMessages } from "../src/services/messages.js";
import { randomUUID } from "node:crypto";

const config = loadConfig();
const hasDb = !!config.DATABASE_URL;

describe("Session Integration Tests", { skip: !hasDb }, () => {
  let pool: Pool;

  before(async () => {
    pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
  });

  after(async () => {
    await pool.end();
  });

  async function withTestSession(fn: (sessionId: string) => Promise<void>) {
    const testSessionId = randomUUID();
    await pool.query(
      "INSERT INTO sessions (id, status, mode) VALUES ($1, 'active', 'text')",
      [testSessionId]
    );
    try {
      await fn(testSessionId);
    } finally {
      await pool.query("DELETE FROM sessions WHERE id = $1", [testSessionId]);
    }
  }

  describe("persistMessage", () => {
    it("persists user message and returns messageId", async () => {
      await withTestSession(async (testSessionId) => {
        const result = await persistMessage(pool, testSessionId, "user", "Hello world");
        assert.ok(result !== null);
        assert.ok(result!.messageId);
        assert.ok(result!.createdAt);
      });
    });

    it("persists buddy message", async () => {
      await withTestSession(async (testSessionId) => {
        const result = await persistMessage(pool, testSessionId, "buddy", "Hi there!");
        assert.ok(result !== null);
      });
    });

    it("persists message with prosody", async () => {
      await withTestSession(async (testSessionId) => {
        const prosody = { f0Mean: 150, f0Std: 20, speechRate: 2.5, pauseRatio: 0.3, rmsEnergy: 0.05 };
        const result = await persistMessage(pool, testSessionId, "user", "Test", prosody);
        assert.ok(result !== null);

        const { rows } = await pool.query(
          "SELECT prosody FROM session_messages WHERE id = $1",
          [result!.messageId]
        );
        assert.deepEqual(rows[0].prosody, prosody);
      });
    });

    it("returns null for non-existent session", async () => {
      const result = await persistMessage(pool, randomUUID(), "user", "Test");
      assert.equal(result, null);
    });

    it("returns null for ended session", async () => {
      await withTestSession(async (testSessionId) => {
        await pool.query("UPDATE sessions SET status = 'ended' WHERE id = $1", [testSessionId]);
        const result = await persistMessage(pool, testSessionId, "user", "Test");
        assert.equal(result, null);
      });
    });

    it("updates last_active_at on message", async () => {
      await withTestSession(async (testSessionId) => {
        const before = await pool.query("SELECT last_active_at FROM sessions WHERE id = $1", [testSessionId]);
        await new Promise(r => setTimeout(r, 10));
        await persistMessage(pool, testSessionId, "user", "Test");
        const after = await pool.query("SELECT last_active_at FROM sessions WHERE id = $1", [testSessionId]);
        assert.ok(new Date(after.rows[0].last_active_at) >= new Date(before.rows[0].last_active_at));
      });
    });
  });

  describe("listRecentMessages", () => {
    it("returns messages in chronological order", async () => {
      await withTestSession(async (testSessionId) => {
        await persistMessage(pool, testSessionId, "user", "First");
        await persistMessage(pool, testSessionId, "buddy", "Second");
        await persistMessage(pool, testSessionId, "user", "Third");

        const messages = await listRecentMessages(pool, testSessionId, 10);
        assert.equal(messages.length, 3);
        assert.equal(messages[0].content, "First");
        assert.equal(messages[1].content, "Second");
        assert.equal(messages[2].content, "Third");
      });
    });

    it("limits to requested count", async () => {
      await withTestSession(async (testSessionId) => {
        for (let i = 0; i < 15; i++) {
          await persistMessage(pool, testSessionId, "user", `Msg ${i}`);
        }
        const messages = await listRecentMessages(pool, testSessionId, 5);
        assert.equal(messages.length, 5);
        assert.equal(messages[0].content, "Msg 10");
      });
    });

    it("returns empty array for session with no messages", async () => {
      await withTestSession(async (testSessionId) => {
        const messages = await listRecentMessages(pool, testSessionId);
        assert.deepEqual(messages, []);
      });
    });
  });
});