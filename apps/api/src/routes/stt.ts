/**
 * Speech-to-text proxy: browsers without a native speech engine record audio
 * (MediaRecorder) and POST it here; we forward to the local faster-whisper
 * sidecar. Session-token auth required — the sidecar itself is never exposed.
 * Audio passes through in memory only; nothing is written or retained.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ErrorEnvelope } from "@zenith/contracts";
import type { Config } from "../config.js";
import { verifySessionToken } from "../auth/sessionToken.js";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // ~30s of opus is well under this

export function registerSttRoute(app: FastifyInstance, config: Config) {
  // Accept audio bodies as raw buffers.
  app.addContentTypeParser(
    ["audio/webm", "audio/ogg", "audio/wav", "audio/mp4", "application/octet-stream"],
    { parseAs: "buffer", bodyLimit: MAX_AUDIO_BYTES },
    (_req, body, done) => done(null, body),
  );

  function authed(req: FastifyRequest): boolean {
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ")
      ? auth.slice("Bearer ".length)
      : req.cookies?.zenith_session;
    return !!token && !!verifySessionToken(token, config.SESSION_TOKEN_SECRET);
  }

  // Neural text-to-speech for buddy replies (voice mode). The sidecar's
  // edge engine sends reply text (never user words, never identity) to
  // Microsoft's free neural voices; clients fall back to local
  // speechSynthesis when this returns non-200.
  app.post<{ Body: { text?: string; lang?: string } }>("/api/v1/tts", async (req, reply) => {
    if (!authed(req)) {
      const body: ErrorEnvelope = {
        error: { code: "UNAUTHORIZED", message: "Missing or invalid session token" },
      };
      return reply.code(401).send(body);
    }
    try {
      const res = await fetch(`${config.STT_URL}/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: req.body?.text ?? "", lang: req.body?.lang ?? "en" }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return reply.code(503).send();
      const audio = Buffer.from(await res.arrayBuffer());
      return reply.header("content-type", "audio/mpeg").send(audio);
    } catch {
      return reply.code(503).send();
    }
  });

  app.post<{ Querystring: { lang?: string } }>("/api/v1/stt", async (req, reply) => {
    if (!authed(req)) {
      const body: ErrorEnvelope = {
        error: { code: "UNAUTHORIZED", message: "Missing or invalid session token" },
      };
      return reply.code(401).send(body);
    }

    const audio = req.body as Buffer | undefined;
    if (!audio || audio.length === 0) {
      return reply.send({ text: "", language: "" });
    }

    try {
      const lang = req.query.lang ? `?lang=${encodeURIComponent(req.query.lang)}` : "";
      const res = await fetch(`${config.STT_URL}/stt${lang}`, {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] ?? "application/octet-stream" },
        body: new Uint8Array(audio),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`sidecar HTTP ${res.status}`);
      return reply.send(await res.json());
    } catch (err) {
      app.log.warn({ err: { message: (err as Error).message } }, "stt sidecar unavailable");
      const body: ErrorEnvelope = {
        error: { code: "STT_UNAVAILABLE", message: "Speech recognition is unavailable" },
      };
      return reply.code(503).send(body);
    }
  });
}
