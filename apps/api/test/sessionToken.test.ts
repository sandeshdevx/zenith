import { test } from "node:test";
import assert from "node:assert/strict";
import { signSessionToken, verifySessionToken } from "../src/auth/sessionToken.js";

const SECRET = "test-secret-at-least-16-chars";

test("round-trips a valid token", () => {
  const sid = "3f1d9a2e-1111-4222-8333-444455556666";
  const token = signSessionToken(sid, SECRET);
  const payload = verifySessionToken(token, SECRET);
  assert.ok(payload);
  assert.equal(payload.sid, sid);
});

test("rejects a tampered payload", () => {
  const token = signSessionToken("3f1d9a2e-1111-4222-8333-444455556666", SECRET);
  const [body = "", sig = ""] = token.split(".");
  const other = Buffer.from(
    JSON.stringify({ sid: "aaaaaaaa-0000-4000-8000-000000000000", iat: 0, exp: 9999999999 }),
  ).toString("base64url");
  assert.equal(verifySessionToken(`${other}.${sig}`, SECRET), null);
  assert.equal(verifySessionToken(`${body}.AAAA${sig.slice(4)}`, SECRET), null);
});

test("rejects a token signed with a different secret", () => {
  const token = signSessionToken("3f1d9a2e-1111-4222-8333-444455556666", "another-secret-16chars!");
  assert.equal(verifySessionToken(token, SECRET), null);
});

test("rejects an expired token", () => {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const token = signSessionToken("3f1d9a2e-1111-4222-8333-444455556666", SECRET, twoHoursAgo);
  assert.equal(verifySessionToken(token, SECRET), null);
});

test("rejects malformed tokens", () => {
  assert.equal(verifySessionToken("", SECRET), null);
  assert.equal(verifySessionToken("no-dot-here", SECRET), null);
  assert.equal(verifySessionToken(".only-sig", SECRET), null);
});
