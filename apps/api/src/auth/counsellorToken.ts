/**
 * Counsellor session tokens — same HMAC construction as anonymous session
 * tokens but a distinct type marker and payload, so one can never be used
 * as the other.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface CounsellorTokenPayload {
  typ: "counsellor";
  cid: string;
  role: "counsellor" | "supervisor" | "admin";
  iat: number;
  exp: number;
}

const TTL_SECONDS = 12 * 60 * 60; // one shift

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function hmac(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function signCounsellorToken(
  counsellorId: string,
  role: CounsellorTokenPayload["role"],
  secret: string,
  nowMs = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const payload: CounsellorTokenPayload = {
    typ: "counsellor",
    cid: counsellorId,
    role,
    iat,
    exp: iat + TTL_SECONDS,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf-8"));
  return `${body}.${b64url(hmac(body, secret))}`;
}

export function verifyCounsellorToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): CounsellorTokenPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  let given: Buffer;
  try {
    given = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  const expected = hmac(body, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: CounsellorTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (payload.typ !== "counsellor" || typeof payload.cid !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < nowMs) return null;
  return payload;
}
