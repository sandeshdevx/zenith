import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { signSessionToken, verifySessionToken, SessionTokenPayload } from "../src/auth/sessionToken.js";
import { createHmac } from "node:crypto";

const SECRET = "test-secret-key-for-unit-tests-only-32chars!!";

describe("Session Token (HMAC-SHA256)", () => {
  describe("signSessionToken", () => {
    it("produces a token with two parts separated by dot", () => {
      const token = signSessionToken("test-session-id", SECRET);
      const parts = token.split(".");
      assert.equal(parts.length, 2);
      assert.ok(parts[0].length > 0);
      assert.ok(parts[1].length > 0);
    });

    it("payload is valid base64url JSON with sid, iat, exp", () => {
      const token = signSessionToken("abc-123", SECRET);
      const payloadPart = token.split(".")[0];
      const decoded = Buffer.from(payloadPart, "base64url").toString("utf-8");
      const payload = JSON.parse(decoded) as SessionTokenPayload;
      assert.equal(payload.sid, "abc-123");
      assert.equal(typeof payload.iat, "number");
      assert.equal(typeof payload.exp, "number");
      assert.ok(payload.exp > payload.iat);
    });

    it("expiry is 1 hour from iat", () => {
      const token = signSessionToken("test", SECRET);
      const payloadPart = token.split(".")[0];
      const decoded = Buffer.from(payloadPart, "base64url").toString("utf-8");
      const payload = JSON.parse(decoded) as SessionTokenPayload;
      assert.equal(payload.exp - payload.iat, 3600);
    });

    it("different sessions produce different tokens", () => {
      const t1 = signSessionToken("session-1", SECRET);
      const t2 = signSessionToken("session-2", SECRET);
      assert.notEqual(t1, t2);
    });
  });

  describe("verifySessionToken", () => {
    it("verifies valid token and returns payload", () => {
      const token = signSessionToken("valid-session", SECRET);
      const payload = verifySessionToken(token, SECRET);
      assert.ok(payload !== null);
      assert.equal(payload!.sid, "valid-session");
    });

    it("rejects token with wrong secret", () => {
      const token = signSessionToken("test", SECRET);
      const payload = verifySessionToken(token, "wrong-secret");
      assert.equal(payload, null);
    });

    it("rejects tampered signature (timingSafeEqual)", () => {
      const token = signSessionToken("test", SECRET);
      const [payload, sig] = token.split(".");
      const tamperedSig = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
      const tamperedToken = `${payload}.${tamperedSig}`;
      const payload2 = verifySessionToken(tamperedToken, SECRET);
      assert.equal(payload2, null);
    });

    it("rejects expired token", () => {
      const pastIat = Math.floor(Date.now() / 1000) - 7200;
      const payload: SessionTokenPayload = { sid: "expired", iat: pastIat, exp: pastIat + 3600 };
      const body = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
      const sig = createHmac("sha256", SECRET).update(body).digest().toString("base64url");
      const token = `${body}.${sig}`;
      const result = verifySessionToken(token, SECRET);
      assert.equal(result, null);
    });

    it("rejects malformed token (no dot)", () => {
      const result = verifySessionToken("not.a.valid.token", SECRET);
      assert.equal(result, null);
    });

    it("rejects token with invalid base64url", () => {
      const result = verifySessionToken("!!!invalid!!!@@@", SECRET);
      assert.equal(result, null);
    });

    it("rejects token with invalid JSON payload", () => {
      const invalidPayload = Buffer.from("not json", "utf-8").toString("base64url");
      const sig = createHmac("sha256", SECRET).update(invalidPayload).digest().toString("base64url");
      const token = `${invalidPayload}.${sig}`;
      const result = verifySessionToken(token, SECRET);
      assert.equal(result, null);
    });

    it("rejects token missing required fields", () => {
      const payload = { sid: "test" };
      const body = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
      const sig = createHmac("sha256", SECRET).update(body).digest().toString("base64url");
      const token = `${body}.${sig}`;
      const result = verifySessionToken(token, SECRET);
      assert.equal(result, null);
    });
  });

  describe("Round-trip", () => {
    it("sign -> verify preserves session ID", () => {
      const sessionId = "round-trip-test-" + Date.now();
      const token = signSessionToken(sessionId, SECRET);
      const payload = verifySessionToken(token, SECRET);
      assert.ok(payload !== null);
      assert.equal(payload!.sid, sessionId);
    });

    it("different secrets produce incompatible tokens", () => {
      const token1 = signSessionToken("same", "secret-1");
      const token2 = signSessionToken("same", "secret-2");
      assert.equal(verifySessionToken(token1, "secret-2"), null);
      assert.equal(verifySessionToken(token2, "secret-1"), null);
    });
  });
});