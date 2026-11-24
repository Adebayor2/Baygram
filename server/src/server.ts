 import express from "express";
import http from "http";
import cors from "cors";
 import helmet from "helmet";
 import { pinoHttp } from "pino-http";
 import depthLimit from "graphql-depth-limit";
 import { GraphQLError } from "graphql";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";

import { env } from "./config/env.js";
import { prisma } from "./config/db.js";
import { redis } from "./config/redis.js";
import { supabase } from "./config/supabase.js";
import { typeDefs, resolvers } from "./graphql/schema.js";
import { buildContext, type AppContext } from "./graphql/context.js";
import { initIO } from "./realtime/io.js";
import { getIO } from "./realtime/io.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { configurePush, registerChatPushHook } from "./modules/push/service.js";
import { logger } from "./config/logger.js";
import { rateLimit } from "./lib/rateLimit.js";
import {
  notificationQueue,
  mediaQueue,
  maintenanceQueue,
  pushQueue,
  callsQueue,
  bullRedis,
} from "./config/queues.js";

let httpServer: http.Server | null = null;
let shuttingDown = false;
let apolloServer: ApolloServer<AppContext> | null = null;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function start() {
  const app = express();
  configurePush();
  registerChatPushHook();
  const server = http.createServer(app);
  httpServer = server;
  app.set("trust proxy", 1);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req: http.IncomingMessage, res: http.ServerResponse) => {
        const existing = req.headers["x-request-id"];
        const requestId =
          typeof existing === "string" && existing
            ? existing
            : crypto.randomUUID();
        res.setHeader("x-request-id", requestId);
        return requestId;
      },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'req.body.password',
          'req.body.access_token',
          'req.body.message',
        ],
        censor: "[REDACTED]",
      },
    })
  );
  app.use(helmet());

  const allowedOrigins = env.clientOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin:
        env.nodeEnv === "production"
          ? allowedOrigins
          : allowedOrigins.length
            ? allowedOrigins
            : true,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "100kb" }));

  const apollo = new ApolloServer<AppContext>({
    typeDefs,
    resolvers,
    introspection: env.nodeEnv !== "production",
    validationRules: [depthLimit(8)],
    plugins: [ApolloServerPluginDrainHttpServer({ httpServer: server })],
    formatError: (formattedError, error) => {
      const code = formattedError.extensions?.code as string | undefined;
      const knownCodes = new Set([
        "UNAUTHENTICATED",
        "FORBIDDEN",
        "NOT_FOUND",
        "BAD_USER_INPUT",
        "CONFLICT",
        "RATE_LIMITED",
        "GRAPHQL_VALIDATION_FAILED",
        "GRAPHQL_PARSE_FAILED",
      ]);

      if (code && knownCodes.has(code)) {
        if (env.nodeEnv === "production") {
          const { stacktrace, ...safeExtensions } = (formattedError.extensions ??
            {}) as Record<string, unknown>;
          return { ...formattedError, extensions: safeExtensions };
        }
        return formattedError;
      }

      const requestId = crypto.randomUUID();
      logger.error({ err: error, requestId }, "Unexpected GraphQL error");
      return {
        message: "Internal server error.",
        extensions: {
          code: "INTERNAL_SERVER_ERROR",
          requestId,
        },
      };
    },
  });
  apolloServer = apollo;
  await apollo.start();
  initIO(server);

  if (env.nodeEnv !== "production") {
    const serverDir = dirname(fileURLToPath(import.meta.url));
    app.use("/push-test", express.static(join(serverDir, "..", "public", "push-test")));
    app.use("/call-test", express.static(join(serverDir, "..", "public", "call-test")));
  }

  app.get("/health", (_req, res) => {
    // Liveness stays cheap; dependency checks belong to /ready.
    res.json({ status: "ok", instance: env.instanceId });
  });

  app.get("/ready", async (req, res) => {
    const simulate = env.nodeEnv !== "production" ? req.query.simulate : undefined;
    let postgresUp = false;
    if (simulate !== "postgres_down") {
      try {
        await withTimeout(prisma.$queryRaw`SELECT 1`, 5000, "Postgres timeout");
        postgresUp = true;
      } catch {
        postgresUp = false;
      }
    }

    let redisUp = false;
    if (simulate !== "redis_down" && redis.status === "ready") {
      try {
        const pingResult = await withTimeout(redis.ping(), 2000, "Redis ping timeout");
        if (pingResult === "PONG") {
          redisUp = true;
        }
      } catch {
        redisUp = false;
      }
    }

    const ready = postgresUp && redisUp;
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      instance: env.instanceId,
      postgres: postgresUp ? "up" : "down",
      redis: redisUp ? "up" : "down",
    });
  });

  app.use("/graphql", async (req, res, next) => {
    if (shuttingDown) {
      res.status(503).json({ status: "shutting_down" });
      return;
    }
    try {
      await rateLimit({
        scope: "http",
        id: req.ip ?? "unknown",
        limit: 300,
        windowSec: 60,
      });
      next();
    } catch (error) {
      if (error instanceof GraphQLError) {
        const retryAfter =
          typeof error.extensions.retryAfterSeconds === "number"
            ? error.extensions.retryAfterSeconds
            : 60;
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({
          errors: [
            {
              message: "Too many requests.",
              extensions: {
                code: "RATE_LIMITED",
                retryAfterSeconds: retryAfter,
              },
            },
          ],
        });
        return;
      }
      next(error);
    }
  });

  app.use(
    "/graphql",
    expressMiddleware(apollo, {
      context: async ({ req }): Promise<AppContext> => buildContext(req),
    })
  );

  httpServer.listen(env.port, () => {
    console.log(`Server ready at http://localhost:${env.port}/graphql`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Shutdown step 1: stop accepting HTTP");
  const forceTimer = setTimeout(() => {
    logger.error("Shutdown force exit after 10 seconds");
    process.exit(1);
  }, 10000);
  forceTimer.unref();
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  }
  logger.info("Shutdown step 2: close Socket.IO");
  try {
    await getIO().close();
  } catch {
    // IO is already absent during startup failures.
  }
  logger.info("Shutdown step 3: stop Apollo");
  await apolloServer?.stop();
  logger.info("Shutdown step 4: close BullMQ queues");
  await Promise.all([
    notificationQueue.close(),
    mediaQueue.close(),
    maintenanceQueue.close(),
    pushQueue.close(),
    callsQueue.close(),
  ]);
  await bullRedis.quit();
  logger.info("Shutdown step 5: close Redis");
  await redis.quit();
  logger.info("Shutdown step 6: disconnect Prisma");
  await prisma.$disconnect();
  logger.info("Shutdown complete");
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
process.on("message", (msg) => {
  if (msg === "shutdown" || msg === "SIGTERM") void shutdown();
});
