import Fastify, { type FastifyError } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import type { ErrorEnvelope } from "@zenith/contracts";
import type { Config } from "./config.js";
import { getPool } from "./db/pool.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSupportOptionsRoute } from "./routes/supportOptions.js";
import { registerWsGateway, type UserMessageHook } from "./realtime/gateway.js";

export interface ServerOptions {
  /** Phase 3+: AI Buddy pipeline invoked on each user message. */
  onUserMessage?: UserMessageHook;
}

export function buildServer(config: Config, options: ServerOptions = {}) {
  const app = Fastify({
    logger: {
      level: "info",
      // Anonymity guarantee: never log request bodies or query strings —
      // conversation content must not reach log storage.
      serializers: {
        req(req) {
          return { method: req.method, url: req.url.split("?")[0] };
        },
      },
    },
  });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    app.log.error({ err: { message: err.message, code: err.code } });
    const body: ErrorEnvelope = {
      error: {
        code: err.code ?? "INTERNAL_ERROR",
        message: err.statusCode && err.statusCode < 500 ? err.message : "Internal error",
      },
    };
    reply.code(err.statusCode ?? 500).send(body);
  });

  app.setNotFoundHandler((_req, reply) => {
    const body: ErrorEnvelope = {
      error: { code: "NOT_FOUND", message: "Route not found" },
    };
    reply.code(404).send(body);
  });

  app.register(fastifyCookie);

  const pool = getPool(config);
  app.addHook("onClose", async () => {
    const { closePool } = await import("./db/pool.js");
    await closePool();
  });

  registerHealthRoutes(app, config, pool);
  registerSessionRoutes(app, config, pool, options.onUserMessage);
  registerSupportOptionsRoute(app);

  app.register(async (instance) => {
    await instance.register(fastifyWebsocket);
    registerWsGateway(instance, config, pool, options.onUserMessage);
  });

  return app;
}
