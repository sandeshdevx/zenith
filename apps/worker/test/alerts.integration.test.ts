import { describe, it, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { Pool } from "pg";
import {
  raiseAlert,
  expireStaleAlerts,
  deliverRedFallback,
  RED_FALLBACK_DELAY_SECONDS,
} from "../src/risk.js";
import { randomUUID } from "node:crypto";

const databaseUrl = process.env.DATABASE_URL || "postgres://zenith:zenith@localhost:5432/zenith";
const hasDb = !!process.env.DATABASE_URL;

describe("Alert Lifecycle Integration Tests", { skip: !hasDb }, () => {
  let pool: Pool;
  let testSessionId: string;

  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
  });

  after(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    testSessionId = randomUUID();
    await pool.query(
      "INSERT INTO sessions (id, status, mode, risk_tier) VALUES ($1, 'active', 'text', 'green')",
      [testSessionId]
    );
  });

  afterEach(async () => {
    await pool.query("DELETE FROM alerts WHERE session_id = $1", [testSessionId]);
    await pool.query("DELETE FROM sessions WHERE id = $1", [testSessionId]);
  });

  describe("raiseAlert", () => {
    it("creates orange alert and returns alertId", async () => {
      const alertId = await raiseAlert(pool, testSessionId, "orange");
      assert.ok(alertId !== null);

      const { rows } = await pool.query("SELECT * FROM alerts WHERE id = $1", [alertId]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tier, "orange");
      assert.equal(rows[0].status, "active");
      assert.equal(rows[0].session_id, testSessionId);
    });

    it("creates red alert", async () => {
      const alertId = await raiseAlert(pool, testSessionId, "red");
      assert.ok(alertId !== null);

      const { rows } = await pool.query("SELECT * FROM alerts WHERE id = $1", [alertId]);
      assert.equal(rows[0].tier, "red");
    });

    it("prevents duplicate active alerts per session (unique index)", async () => {
      const alertId1 = await raiseAlert(pool, testSessionId, "orange");
      const alertId2 = await raiseAlert(pool, testSessionId, "orange");
      assert.equal(alertId2, null);
      assert.ok(alertId1 !== null);
    });

    it("allows new alert after previous expires", async () => {
      const alertId1 = await raiseAlert(pool, testSessionId, "orange");
      assert.ok(alertId1 !== null);

      await pool.query("UPDATE alerts SET status = 'expired' WHERE id = $1", [alertId1]);

      const alertId2 = await raiseAlert(pool, testSessionId, "orange");
      assert.ok(alertId2 !== null);
      assert.notEqual(alertId2, alertId1);
    });
  });

  describe("expireStaleAlerts", () => {
    it("expires alerts past expires_at", async () => {
      const alertId = await raiseAlert(pool, testSessionId, "orange");
      assert.ok(alertId !== null);

      await pool.query("UPDATE alerts SET expires_at = now() - interval '1 minute' WHERE id = $1", [alertId]);

      const expired = await expireStaleAlerts(pool);
      assert.equal(expired, 1);

      const { rows } = await pool.query("SELECT status FROM alerts WHERE id = $1", [alertId]);
      assert.equal(rows[0].status, "expired");
    });

    it("does not expire active alerts", async () => {
      const alertId = await raiseAlert(pool, testSessionId, "orange");
      const expired = await expireStaleAlerts(pool);
      assert.equal(expired, 0);
    });
  });

  describe("deliverRedFallback", () => {
    it("delivers fallback message when alert still active", async () => {
      const alertId = await raiseAlert(pool, testSessionId, "red");
      assert.ok(alertId !== null);

      await pool.query("UPDATE alerts SET expires_at = now() + interval '10 minutes' WHERE id = $1", [alertId]);

      const delivered = await deliverRedFallback(pool, alertId);
      assert.equal(delivered, true);

      const { rows } = await pool.query(
        "SELECT content FROM session_messages WHERE session_id = $1 AND sender = 'buddy' ORDER BY id DESC LIMIT 1",
        [testSessionId]
      );
      assert.equal(rows.length, 1);
      assert.ok(rows[0].content.includes("iCall"));
    });

    it("returns false if alert already accepted", async () => {
      const alertId = await raiseAlert(pool, testSessionId, "red");
      await pool.query("UPDATE alerts SET status = 'accepted' WHERE id = $1", [alertId]);

      const delivered = await deliverRedFallback(pool, alertId);
      assert.equal(delivered, false);
    });

    it("returns false if alert expired", async () => {
      const alertId = await raiseAlert(pool, testSessionId, "red");
      await pool.query("UPDATE alerts SET status = 'expired' WHERE id = $1", [alertId]);

      const delivered = await deliverRedFallback(pool, alertId);
      assert.equal(delivered, false);
    });
  });
});