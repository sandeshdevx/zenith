import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { ErrorEnvelope } from "@zenith/contracts";
import type { Config } from "../config.js";
import {
  signCounsellorToken,
  verifyCounsellorToken,
  type CounsellorTokenPayload,
} from "../auth/counsellorToken.js";
import { generateTotpSecret, totpUri, verifyTotp } from "../auth/totp.js";
import { requestMagicLink, verifyMagicLink } from "../services/counsellorAuth.js";
import { acceptAlert, declineAlert, listActiveAlerts } from "../services/alerts.js";
import { newRoomUrl, offerHandoffToUser } from "../services/handoff.js";

const COOKIE_NAME = "zenith_counsellor";

const loginBodySchema = z.object({ email: z.string().email() });
const verifyBodySchema = z.object({
  token: z.string().min(10),
  totpCode: z.string().optional(),
});
const availabilityBodySchema = z.object({ available: z.boolean() });

function unauthorized(reply: FastifyReply): FastifyReply {
  const body: ErrorEnvelope = {
    error: { code: "UNAUTHORIZED", message: "Counsellor authentication required" },
  };
  return reply.code(401).send(body);
}

export function registerCounsellorRoutes(app: FastifyInstance, config: Config, pool: Pool) {
  function authenticate(req: FastifyRequest): CounsellorTokenPayload | null {
    const cookie = req.cookies?.[COOKIE_NAME];
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length)
      : undefined;
    const token = cookie ?? bearer;
    return token ? verifyCounsellorToken(token, config.SESSION_TOKEN_SECRET) : null;
  }

  app.post("/api/v1/counsellor/login", async (req, reply) => {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const body: ErrorEnvelope = { error: { code: "INVALID_REQUEST", message: "email required" } };
      return reply.code(400).send(body);
    }
    await requestMagicLink(pool, app.log, parsed.data.email);
    // Identical response whether or not the account exists.
    return { sent: true };
  });

  app.post("/api/v1/counsellor/verify", async (req, reply) => {
    const parsed = verifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const body: ErrorEnvelope = { error: { code: "INVALID_REQUEST", message: "token required" } };
      return reply.code(400).send(body);
    }
    const result = await verifyMagicLink(pool, parsed.data.token, parsed.data.totpCode, verifyTotp);
    if (!result) {
      const body: ErrorEnvelope = {
        error: { code: "INVALID_TOKEN", message: "Link is invalid or expired" },
      };
      return reply.code(401).send(body);
    }
    if (result.totpRequired) {
      return reply.code(401).send({ totpRequired: true });
    }
    const token = signCounsellorToken(result.counsellorId, result.role, config.SESSION_TOKEN_SECRET);
    reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.COOKIE_SECURE,
      path: "/",
      maxAge: 12 * 60 * 60,
    });
    return { role: result.role, token };
  });

  app.post("/api/v1/counsellor/totp/enroll", async (req, reply) => {
    const auth = authenticate(req);
    if (!auth) return unauthorized(reply);
    const existing = await pool.query(
      "SELECT totp_secret, email FROM counsellors WHERE id = $1",
      [auth.cid],
    );
    if (!existing.rows[0]) return unauthorized(reply);
    if (existing.rows[0].totp_secret) {
      const body: ErrorEnvelope = {
        error: { code: "ALREADY_ENROLLED", message: "TOTP already enrolled" },
      };
      return reply.code(409).send(body);
    }
    const secret = generateTotpSecret();
    await pool.query("UPDATE counsellors SET totp_secret = $2 WHERE id = $1", [auth.cid, secret]);
    return { secret, uri: totpUri(secret, existing.rows[0].email) };
  });

  app.post("/api/v1/counsellor/availability", async (req, reply) => {
    const auth = authenticate(req);
    if (!auth) return unauthorized(reply);
    const parsed = availabilityBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const body: ErrorEnvelope = {
        error: { code: "INVALID_REQUEST", message: "available (boolean) required" },
      };
      return reply.code(400).send(body);
    }
    await pool.query(
      `INSERT INTO counsellor_availability (counsellor_id, is_available, last_seen_at)
       VALUES ($1, $2, now())
       ON CONFLICT (counsellor_id)
       DO UPDATE SET is_available = $2, last_seen_at = now()`,
      [auth.cid, parsed.data.available],
    );
    return { available: parsed.data.available };
  });

  app.get("/api/v1/counsellor/queue", async (req, reply) => {
    const auth = authenticate(req);
    if (!auth) return unauthorized(reply);
    const alerts = await listActiveAlerts(pool);
    return { alerts };
  });

  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/counsellor/sessions/:sessionId/accept",
    async (req, reply) => {
      const auth = authenticate(req);
      if (!auth) return unauthorized(reply);
      const result = await acceptAlert(pool, req.params.sessionId, auth.cid);
      if (!result) {
        const body: ErrorEnvelope = {
          error: { code: "ALERT_GONE", message: "Alert already claimed or expired" },
        };
        return reply.code(409).send(body);
      }
      // Fan out the claim so every dashboard (any instance) removes it.
      await pool.query("SELECT pg_notify('zenith_alert_claimed', $1)", [
        `${result.alertId}:${result.sessionId}`,
      ]);
      // Phase 6: room for the counsellor now; buddy-framed offer to the user.
      const roomUrl = newRoomUrl(config.JITSI_BASE_URL);
      await offerHandoffToUser(pool, result.sessionId, roomUrl);
      return { accepted: true, sessionId: result.sessionId, tier: result.tier, roomUrl };
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/counsellor/sessions/:sessionId/decline",
    async (req, reply) => {
      const auth = authenticate(req);
      if (!auth) return unauthorized(reply);
      await declineAlert(pool, req.params.sessionId, auth.cid);
      return { declined: true };
    },
  );
}
