import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { DependencyStatus, ReadyResponse } from "@zenith/contracts";
import type { Config } from "../config.js";

const DEPENDENCY_TIMEOUT_MS = 2000;

async function checkPostgres(pool: Pool): Promise<DependencyStatus> {
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
      return { name: "postgres", ok: true };
    } finally {
      client.release();
    }
  } catch (err) {
    return {
      name: "postgres",
      ok: false,
      detail: err instanceof Error && err.message ? err.message : "unreachable",
    };
  }
}

async function checkOllama(baseUrl: string): Promise<DependencyStatus> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(DEPENDENCY_TIMEOUT_MS),
    });
    return res.ok
      ? { name: "ollama", ok: true }
      : { name: "ollama", ok: false, detail: `HTTP ${res.status}` };
  } catch {
    return { name: "ollama", ok: false, detail: "unreachable" };
  }
}

export function registerHealthRoutes(app: FastifyInstance, config: Config, pool: Pool) {
  app.get("/api/v1/health", async () => ({
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get("/api/v1/ready", async (_req, reply) => {
    const dependencies = await Promise.all([
      checkPostgres(pool),
      checkOllama(config.OLLAMA_URL),
    ]);
    const body: ReadyResponse = {
      ready: dependencies.every((d) => d.ok),
      dependencies,
    };
    return reply.code(body.ready ? 200 : 503).send(body);
  });
}
