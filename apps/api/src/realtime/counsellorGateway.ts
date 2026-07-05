/**
 * Counsellor WebSocket plane: /api/v1/counsellor/ws.
 * Same first-frame auth pattern as the user gateway, but a completely
 * separate registry — user frames and counsellor frames can never mix.
 */
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Pool } from "pg";
import {
  counsellorClientFrameSchema,
  type CounsellorServerFrame,
} from "@zenith/contracts";
import type { Config } from "../config.js";
import { verifyCounsellorToken } from "../auth/counsellorToken.js";

const AUTH_DEADLINE_MS = 5000;
const counsellorSockets = new Set<WebSocket>();

export function broadcastToCounsellors(frame: CounsellorServerFrame): void {
  const data = JSON.stringify(frame);
  for (const socket of counsellorSockets) {
    if (socket.readyState === socket.OPEN) socket.send(data);
  }
}

export function onlineCounsellorSockets(): number {
  return counsellorSockets.size;
}

export function registerCounsellorGateway(app: FastifyInstance, config: Config, pool: Pool) {
  app.get("/api/v1/counsellor/ws", { websocket: true }, (socket: WebSocket) => {
    let counsellorId: string | null = null;

    const authTimer = setTimeout(() => {
      if (!counsellorId) socket.close(4401, "auth timeout");
    }, AUTH_DEADLINE_MS);

    socket.on("message", async (raw: Buffer) => {
      let frame;
      try {
        frame = counsellorClientFrameSchema.parse(JSON.parse(raw.toString("utf-8")));
      } catch {
        return;
      }

      if (frame.type === "auth") {
        const payload = verifyCounsellorToken(frame.token, config.SESSION_TOKEN_SECRET);
        if (!payload) {
          const err: CounsellorServerFrame = { type: "auth.error", reason: "invalid token" };
          socket.send(JSON.stringify(err));
          socket.close(4401, "invalid token");
          return;
        }
        clearTimeout(authTimer);
        counsellorId = payload.cid;
        counsellorSockets.add(socket);
        // Socket presence doubles as a heartbeat.
        await pool
          .query(
            `INSERT INTO counsellor_availability (counsellor_id, is_available, last_seen_at)
             VALUES ($1, true, now())
             ON CONFLICT (counsellor_id) DO UPDATE SET last_seen_at = now()`,
            [counsellorId],
          )
          .catch(() => {});
        const ok: CounsellorServerFrame = { type: "auth.ok", counsellorId };
        socket.send(JSON.stringify(ok));
        return;
      }

      if (!counsellorId) {
        socket.close(4401, "not authenticated");
        return;
      }
      if (frame.type === "ping") {
        await pool
          .query(
            "UPDATE counsellor_availability SET last_seen_at = now() WHERE counsellor_id = $1",
            [counsellorId],
          )
          .catch(() => {});
        const pong: CounsellorServerFrame = { type: "pong" };
        socket.send(JSON.stringify(pong));
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      counsellorSockets.delete(socket);
    });
    socket.on("error", () => {});
  });
}
