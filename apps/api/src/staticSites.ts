/**
 * Production static hosting: the API serves both built frontends so a full
 * deployment is one Node process + PostgreSQL + Ollama. In dev (no dist
 * folders) only the JSON 404 handler is installed — Vite serves the apps.
 *   /            → apps/web/dist        (anonymous PWA)
 *   /counsellor  → apps/dashboard/dist  (counsellor dashboard)
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import type { ErrorEnvelope } from "@zenith/contracts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function registerStaticSites(app: FastifyInstance): void {
  const webDist = process.env.WEB_DIST ?? path.join(REPO_ROOT, "apps/web/dist");
  const dashboardDist =
    process.env.DASHBOARD_DIST ?? path.join(REPO_ROOT, "apps/dashboard/dist");
  const hasWeb = existsSync(path.join(webDist, "index.html"));
  const hasDashboard = existsSync(path.join(dashboardDist, "index.html"));

  if (hasDashboard) {
    app.register(fastifyStatic, {
      root: dashboardDist,
      prefix: "/counsellor/",
      decorateReply: false,
    });
    app.get("/counsellor", (_req, reply) => reply.redirect("/counsellor/"));
  }

  if (hasWeb) {
    app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      decorateReply: true,
    });
  }

  app.setNotFoundHandler((req, reply) => {
    // SPA fallback: unknown GET routes outside /api serve the PWA shell.
    if (hasWeb && req.method === "GET" && !req.url.startsWith("/api/")) {
      return (reply as unknown as { sendFile: (f: string, r: string) => unknown }).sendFile(
        "index.html",
        webDist,
      );
    }
    const body: ErrorEnvelope = {
      error: { code: "NOT_FOUND", message: "Route not found" },
    };
    return reply.code(404).send(body);
  });
}
