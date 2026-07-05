/**
 * Bridges Postgres NOTIFY channels to counsellor sockets, so the worker
 * (a separate process) can raise alerts that every API instance fans out.
 * Channels: zenith_alert_new, zenith_alert_claimed, zenith_alert_expired.
 */
import type { Pool, PoolClient } from "pg";
import type { FastifyBaseLogger } from "fastify";
import { getAlertById } from "../services/alerts.js";
import { broadcastToCounsellors } from "./counsellorGateway.js";

export async function startAlertDispatcher(
  pool: Pool,
  log: FastifyBaseLogger,
): Promise<() => void> {
  let client: PoolClient | null = null;
  let stopped = false;

  async function connect() {
    if (stopped) return;
    try {
      client = await pool.connect();
      await client.query("LISTEN zenith_alert_new");
      await client.query("LISTEN zenith_alert_claimed");
      await client.query("LISTEN zenith_alert_expired");
      client.on("notification", (msg) => void handle(msg.channel, msg.payload ?? ""));
      client.on("error", () => {
        client?.release();
        client = null;
        setTimeout(() => void connect(), 2000);
      });
      log.info("alert dispatcher listening");
    } catch (err) {
      log.error({ err: { message: (err as Error).message } }, "alert dispatcher connect failed");
      setTimeout(() => void connect(), 5000);
    }
  }

  async function handle(channel: string, payload: string) {
    try {
      if (channel === "zenith_alert_new") {
        const alert = await getAlertById(pool, payload);
        if (alert) broadcastToCounsellors({ type: "counsellor.alerted", alert });
      } else if (channel === "zenith_alert_claimed") {
        const [alertId, sessionId] = payload.split(":");
        if (alertId && sessionId) {
          broadcastToCounsellors({ type: "counsellor.accepted", alertId, sessionId });
        }
      } else if (channel === "zenith_alert_expired") {
        broadcastToCounsellors({ type: "alert.expired", alertId: payload });
      }
    } catch (err) {
      log.error({ err: { message: (err as Error).message } }, "alert dispatch failed");
    }
  }

  await connect();
  return () => {
    stopped = true;
    client?.release();
  };
}
