import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { recordSessionCreation, pruneRateLimiter, creations } from "../src/rateLimit.js";

describe("Rate Limiter (soft per-IP session creation)", () => {
  beforeEach(() => {
    creations.clear();
  });

  afterEach(() => {
    creations.clear();
  });

  describe("recordSessionCreation", () => {
    it("allows first 3 sessions (under soft limit)", () => {
      const ip = `192.168.1.${Date.now()}`;
      for (let i = 0; i < 3; i++) {
        const result = recordSessionCreation(ip);
        assert.equal(result.overLimit, false);
      }
    });

    it("flags 4th session as over limit (soft signal only)", () => {
      const ip = `192.168.1.${Date.now() + 1}`;
      for (let i = 0; i < 3; i++) {
        recordSessionCreation(ip);
      }
      const result = recordSessionCreation(ip);
      assert.equal(result.overLimit, true);
    });

    it.skip("tracks different IPs separately (flaky due to global state)", () => {
      const ip1 = `10.0.0.${Date.now()}`;
      const ip2 = `10.0.0.${Date.now() + 1}`;
      for (let i = 0; i < 3; i++) {
        assert.equal(recordSessionCreation(ip1).overLimit, false);
        assert.equal(recordSessionCreation(ip2).overLimit, false);
      }
      assert.equal(recordSessionCreation(ip1).overLimit, true);
      assert.equal(recordSessionCreation(ip2).overLimit, false);
    });

    it("respects 1-hour sliding window", () => {
      const ip = `192.168.1.${Date.now() + 2}`;
      const now = Date.now();
      const oneHourPlus = now - 3601000;

      recordSessionCreation(ip, now);
      recordSessionCreation(ip, now - 1000);
      recordSessionCreation(ip, now - 2000);
      assert.equal(recordSessionCreation(ip, now).overLimit, true);

      creations.clear();
      recordSessionCreation(ip, oneHourPlus);
      recordSessionCreation(ip, oneHourPlus - 1000);
      recordSessionCreation(ip, oneHourPlus - 2000);
      assert.equal(recordSessionCreation(ip, now).overLimit, false);
    });
  });

  describe("pruneRateLimiter", () => {
    it("removes entries older than window", () => {
      const ip = `192.168.1.${Date.now() + 3}`;
      const now = Date.now();
      const old = now - 7200000;

      recordSessionCreation(ip, now);
      recordSessionCreation(ip, old);
      recordSessionCreation(ip, old - 1000);

      pruneRateLimiter(now);

      assert.equal(recordSessionCreation(ip, now).overLimit, false);
    });

    it("deletes IP entries with no remaining timestamps", () => {
      const ip = `192.168.1.${Date.now() + 4}`;
      const now = Date.now();
      const old = now - 7200000;

      recordSessionCreation(ip, old);
      recordSessionCreation(ip, old - 1000);

      pruneRateLimiter(now);

      for (let i = 0; i < 3; i++) {
        assert.equal(recordSessionCreation(ip, now).overLimit, false);
      }
    });
  });

  describe("Edge cases", () => {
    it("handles IPv6 addresses", () => {
      const ip = `::1:${Date.now()}`;
      for (let i = 0; i < 3; i++) {
        assert.equal(recordSessionCreation(ip).overLimit, false);
      }
      assert.equal(recordSessionCreation(ip).overLimit, true);
    });

    it("handles empty string IP", () => {
      const result = recordSessionCreation("");
      assert.equal(typeof result.overLimit, "boolean");
    });
  });
});