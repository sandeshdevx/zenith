import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { ErrorEnvelope } from "@zenith/contracts";
import type { Config } from "../config.js";
import { acceptAlert, declineAlert, listActiveAlerts } from "../services/alerts.js";
import { newRoomUrl, offerHandoffToUser } from "../services/handoff.js";

const availabilityBodySchema = z.object({ available: z.boolean() });

// Demo counsellor ID (auto-seeded on startup)
const DEMO_COUNSELLOR_ID = "00000000-0000-0000-0000-000000000000";

async function getDemoCounsellorId(pool: Pool): Promise<string> {
  const { rows } = await pool.query(
    "SELECT id FROM counsellors WHERE email = 'demo@zenith.local' LIMIT 1"
  );
  return rows[0]?.id ?? DEMO_COUNSELLOR_ID;
}

export function registerCounsellorRoutes(app: FastifyInstance, config: Config, pool: Pool) {
  // Availability - no auth required
  app.post("/api/v1/counsellor/availability", async (req, reply) => {
    const parsed = availabilityBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const body: ErrorEnvelope = {
        error: { code: "INVALID_REQUEST", message: "available (boolean) required" },
      };
      return reply.code(400).send(body);
    }
    const counsellorId = await getDemoCounsellorId(pool);
    await pool.query(
      `INSERT INTO counsellor_availability (counsellor_id, is_available, last_seen_at)
       VALUES ($1, $2, now())
       ON CONFLICT (counsellor_id)
       DO UPDATE SET is_available = $2, last_seen_at = now()`,
      [counsellorId, parsed.data.available],
    );
    return { available: parsed.data.available };
  });

  // Queue - no auth required
  app.get("/api/v1/counsellor/queue", async (_req, reply) => {
    const alerts = await listActiveAlerts(pool);
    return { alerts };
  });

  // Accept alert - no auth required, use demo counsellor
  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/counsellor/sessions/:sessionId/accept",
    async (req, reply) => {
      const counsellorId = await getDemoCounsellorId(pool);
      const result = await acceptAlert(pool, req.params.sessionId, counsellorId);
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
      // Tier 4 alerts already carry a room; otherwise create one now and deliver the offer.
      const existing = await pool.query(
        "SELECT handoff_room FROM sessions WHERE id = $1",
        [result.sessionId],
      );
      let roomUrl: string = existing.rows[0]?.handoff_room ?? "";
      if (!roomUrl) {
        roomUrl = newRoomUrl(config.JITSI_BASE_URL);
        await offerHandoffToUser(pool, result.sessionId, roomUrl);
      }
      return { accepted: true, sessionId: result.sessionId, tier: result.tier, roomUrl };
    },
  );

  // Decline alert - no auth required
  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/counsellor/sessions/:sessionId/decline",
    async (req, reply) => {
      const counsellorId = await getDemoCounsellorId(pool);
      await declineAlert(pool, req.params.sessionId, counsellorId);
      return { declined: true };
    },
  );
}