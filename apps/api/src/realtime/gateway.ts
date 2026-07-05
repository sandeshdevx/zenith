/**
 * Anonymous user WebSocket gateway.
 * Upgrade at /api/v1/ws; the first frame must be {type:"auth", token} within
 * AUTH_DEADLINE_MS (browsers cannot set upgrade headers). After auth the
 * socket joins the session's broadcast group. Risk data never crosses this
 * socket, by construction — only WsServerFrame variants exist here.
 */
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Pool } from "pg";
import { wsClientFrameSchema, type WsServerFrame } from "@zenith/contracts";
import type { Config } from "../config.js";
import { verifySessionToken } from "../auth/sessionToken.js";
import { persistMessage } from "../services/messages.js";
import { register, unregister, broadcast } from "./registry.js";

const AUTH_DEADLINE_MS = 5000;

/** Phase 3+ plugs the AI Buddy pipeline in here; Phase 2 leaves it undefined. */
export type UserMessageHook = (sessionId: string, content: string) => void;

function send(socket: WebSocket, frame: WsServerFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

export function registerWsGateway(
  app: FastifyInstance,
  config: Config,
  pool: Pool,
  onUserMessage?: UserMessageHook,
) {
  app.get("/api/v1/ws", { websocket: true }, (socket: WebSocket) => {
    let sessionId: string | null = null;

    const authTimer = setTimeout(() => {
      if (!sessionId) {
        send(socket, { type: "auth.error", reason: "auth timeout" });
        socket.close(4401, "auth timeout");
      }
    }, AUTH_DEADLINE_MS);

    socket.on("message", async (raw: Buffer) => {
      let frame;
      try {
        frame = wsClientFrameSchema.parse(JSON.parse(raw.toString("utf-8")));
      } catch {
        send(socket, { type: "error", code: "INVALID_FRAME", message: "Unrecognized frame" });
        return;
      }

      if (frame.type === "auth") {
        const payload = verifySessionToken(frame.token, config.SESSION_TOKEN_SECRET);
        if (!payload) {
          send(socket, { type: "auth.error", reason: "invalid token" });
          socket.close(4401, "invalid token");
          return;
        }
        clearTimeout(authTimer);
        sessionId = payload.sid;
        register(sessionId, socket);
        send(socket, { type: "auth.ok", sessionId });
        return;
      }

      if (!sessionId) {
        send(socket, { type: "auth.error", reason: "not authenticated" });
        socket.close(4401, "not authenticated");
        return;
      }

      if (frame.type === "ping") {
        send(socket, { type: "pong" });
        return;
      }

      if (frame.type === "message") {
        try {
          const persisted = await persistMessage(pool, sessionId, "user", frame.content);
          if (!persisted) {
            send(socket, { type: "error", code: "SESSION_NOT_ACTIVE", message: "Session is not active" });
            return;
          }
          // Ack to every tab of this session, not just the sender.
          broadcast(sessionId, {
            type: "message.received",
            messageId: persisted.messageId,
            createdAt: persisted.createdAt,
          });
          onUserMessage?.(sessionId, frame.content);
        } catch (err) {
          app.log.error({ err: { message: (err as Error).message } }, "ws message persist failed");
          send(socket, { type: "error", code: "INTERNAL_ERROR", message: "Could not save message" });
        }
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (sessionId) unregister(sessionId, socket);
    });
    socket.on("error", () => {
      /* close handler does the cleanup */
    });
  });
}
