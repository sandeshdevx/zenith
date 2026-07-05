import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { CreateSessionResponse, ErrorEnvelope } from "@zenith/contracts";
import type { Config } from "../config.js";
import { signSessionToken, verifySessionToken } from "../auth/sessionToken.js";
import { recordSessionCreation } from "../rateLimit.js";
import { persistMessage, listRecentMessages } from "../services/messages.js";
import { acceptHandoff, declineHandoff, escalateByUser } from "../services/handoff.js";

const COOKIE_NAME = "zenith_session";

const createSessionBodySchema = z
  .object({ mode: z.enum(["text", "voice"]).default("text") })
  .default({ mode: "text" });

const postMessageBodySchema = z.object({
  content: z.string().min(1).max(4000),
});

function unauthorized(reply: FastifyReply): FastifyReply {
  const body: ErrorEnvelope = {
    error: { code: "UNAUTHORIZED", message: "Missing or invalid session token" },
  };
  return reply.code(401).send(body);
}

function extractToken(req: FastifyRequest): string | undefined {
  const cookie = req.cookies?.[COOKIE_NAME];
  if (cookie) return cookie;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return undefined;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  config: Config,
  pool: Pool,
  onUserMessage?: (sessionId: string, content: string, messageId: string) => void,
) {
  /** Auth guard: token must be valid AND bound to the session in the URL. */
  function authorize(req: FastifyRequest, sessionId: string): boolean {
    const token = extractToken(req);
    if (!token) return false;
    const payload = verifySessionToken(token, config.SESSION_TOKEN_SECRET);
    return payload !== null && payload.sid === sessionId;
  }

  app.post("/api/v1/sessions", async (req, reply) => {
    const parsed = createSessionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const body: ErrorEnvelope = {
        error: { code: "INVALID_REQUEST", message: "Invalid session mode" },
      };
      return reply.code(400).send(body);
    }

    const sessionId = randomUUID();
    // Soft limit only — over-limit sessions are still created (PRD: never lock
    // out a user in crisis), but the signal is recorded for abuse monitoring.
    const { overLimit } = recordSessionCreation(req.ip);

    await pool.query(
      "INSERT INTO sessions (id, status, mode) VALUES ($1, 'active', $2)",
      [sessionId, parsed.data.mode],
    );
    if (overLimit) {
      await pool.query(
        "INSERT INTO session_events (session_id, event_type, payload) VALUES ($1, 'rate_limit_soft', $2)",
        [sessionId, JSON.stringify({ scope: "ip_hourly" })], // no IP stored
      );
    }

    const token = signSessionToken(sessionId, config.SESSION_TOKEN_SECRET);
    reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.COOKIE_SECURE,
      path: "/",
      maxAge: 60 * 60,
    });

    const body: CreateSessionResponse & { token: string } = {
      sessionId,
      status: "active",
      createdAt: new Date().toISOString(),
      // Also returned in the body for clients with cookies disabled (TRD:
      // cookie "when supported"). Same lifetime, same signature.
      token,
    };
    return reply.code(201).send(body);
  });

  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId",
    async (req, reply) => {
      const { sessionId } = req.params;
      if (!authorize(req, sessionId)) return unauthorized(reply);

      // Deliberately excludes risk_tier: risk is never exposed on any
      // user-facing surface (PRD Flow B: detection must be invisible).
      const { rows } = await pool.query(
        "SELECT id, status, mode, created_at, last_active_at FROM sessions WHERE id = $1",
        [sessionId],
      );
      const session = rows[0];
      if (!session) {
        const body: ErrorEnvelope = {
          error: { code: "NOT_FOUND", message: "Session not found" },
        };
        return reply.code(404).send(body);
      }
      return {
        sessionId: session.id,
        status: session.status,
        mode: session.mode,
        createdAt: session.created_at,
        lastActiveAt: session.last_active_at,
      };
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/messages",
    async (req, reply) => {
      const { sessionId } = req.params;
      if (!authorize(req, sessionId)) return unauthorized(reply);

      const parsed = postMessageBodySchema.safeParse(req.body);
      if (!parsed.success) {
        const body: ErrorEnvelope = {
          error: { code: "INVALID_REQUEST", message: "content must be 1–4000 characters" },
        };
        return reply.code(400).send(body);
      }

      const persisted = await persistMessage(pool, sessionId, "user", parsed.data.content);
      if (!persisted) {
        const body: ErrorEnvelope = {
          error: { code: "SESSION_NOT_ACTIVE", message: "Session is not active" },
        };
        return reply.code(409).send(body);
      }
      onUserMessage?.(sessionId, parsed.data.content, persisted.messageId);
      return reply.code(201).send(persisted);
    },
  );

  // Reconnect context: the client re-fetches recent messages after a socket
  // drop. DB is the source of truth; the socket is transport only.
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/messages",
    async (req, reply) => {
      const { sessionId } = req.params;
      if (!authorize(req, sessionId)) return unauthorized(reply);
      const messages = await listRecentMessages(pool, sessionId);
      return reply.send({ messages });
    },
  );

  // Manual escape hatch (PRD Flow C): the user asks for a human directly.
  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/escalate",
    async (req, reply) => {
      const { sessionId } = req.params;
      if (!authorize(req, sessionId)) return unauthorized(reply);
      const raised = await escalateByUser(pool, sessionId);
      return reply.send({ requested: true, alreadyPending: !raised });
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/handoff/accept",
    async (req, reply) => {
      const { sessionId } = req.params;
      if (!authorize(req, sessionId)) return unauthorized(reply);
      const roomUrl = await acceptHandoff(pool, sessionId);
      if (!roomUrl) {
        const body: ErrorEnvelope = {
          error: { code: "NO_HANDOFF", message: "No handoff is available" },
        };
        return reply.code(409).send(body);
      }
      return { roomUrl };
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/handoff/decline",
    async (req, reply) => {
      const { sessionId } = req.params;
      if (!authorize(req, sessionId)) return unauthorized(reply);
      await declineHandoff(pool, sessionId);
      return { declined: true };
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/end",
    async (req, reply) => {
      const { sessionId } = req.params;
      if (!authorize(req, sessionId)) return unauthorized(reply);

      await pool.query(
        `UPDATE sessions SET status = 'ended', ended_at = now()
         WHERE id = $1 AND status <> 'ended'`,
        [sessionId],
      );
      reply.clearCookie(COOKIE_NAME, { path: "/" });
      // Content deletion is the purge worker's job and happens within a minute.
      return { ended: true };
    },
  );
}
