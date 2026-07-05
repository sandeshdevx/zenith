/**
 * Anonymous session tokens: HMAC-SHA256 signed, self-contained, no lookup table.
 * Format: base64url(JSON payload) + "." + base64url(HMAC signature).
 * Carries only the session id and expiry — no identity, no device data (TRD §8).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionTokenPayload {
  /** session UUID */
  sid: string;
  /** issued-at, unix seconds */
  iat: number;
  /** expiry, unix seconds */
  exp: number;
}

const TOKEN_TTL_SECONDS = 60 * 60; // 1h; sliding renewal happens on activity

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function hmac(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function signSessionToken(sessionId: string, secret: string, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const payload: SessionTokenPayload = { sid: sessionId, iat, exp: iat + TOKEN_TTL_SECONDS };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf-8"));
  return `${body}.${b64url(hmac(body, secret))}`;
}

export function verifySessionToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): SessionTokenPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  const expected = hmac(body, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: SessionTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (typeof payload.sid !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp * 1000 < nowMs) return null;
  return payload;
}
