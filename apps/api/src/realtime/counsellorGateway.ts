/**
 * Counsellor WebSocket plane: /api/v1/counsellor/ws.
 * No authentication required — all dashboards share the same anonymous connection.
 */
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Pool } from "pg";
import {
  counsellorClientFrameSchema,
  type CounsellorServerFrame,
} from "@zenith/contracts";
import type { Config } from "../config.js";

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
    counsellorSockets.add(socket);

    socket.on("message", async (raw: Buffer) => {
      let frame;
      try {
        frame = counsellorClientFrameSchema.parse(JSON.parse(raw.toString("utf-8")));
      } catch {
        return;
      }

      if (frame.type === "ping") {
        const pong: CounsellorServerFrame = { type: "pong" };
        socket.send(JSON.stringify(pong));
      }
    });

    socket.on("close", () => {
      counsellorSockets.delete(socket);
    });
    socket.on("error", () => {});
  });

  // Listen for pipeline telemetry from the worker via pg_notify
  const client = pool.connect();
  client.then((c) => {
    c.on("notification", (msg) => {
      if (msg.channel === "zenith_pipeline" && msg.payload) {
        try {
          const frame = JSON.parse(msg.payload) as CounsellorServerFrame;
          broadcastToCounsellors(frame);
        } catch {
          // ignore parse errors
        }
      }
    });
    c.query("LISTEN zenith_pipeline");
  });
}