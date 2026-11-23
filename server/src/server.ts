 import express from "express";
import http from "http";
import cors from "cors";
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

async function start() {
  const app = express();
  configurePush();
  registerChatPushHook();
  const httpServer = http.createServer(app);

  const apollo = new ApolloServer<AppContext>({
    typeDefs,
    resolvers,
    plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
  });
  await apollo.start();
  initIO(httpServer);

  app.use(cors());
  app.use(express.json());

  if (env.nodeEnv !== "production") {
    const serverDir = dirname(fileURLToPath(import.meta.url));
    app.use("/push-test", express.static(join(serverDir, "..", "public", "push-test")));
    app.use("/call-test", express.static(join(serverDir, "..", "public", "call-test")));
  }

  app.get("/health", async (_req, res) => {
    const [authCheck, postgresCheck, redisCheck] = await Promise.allSettled([
      fetch(new URL("/auth/v1/health", env.supabaseUrl), {
        headers: { apikey: env.supabasePublishableKey },
        signal: AbortSignal.timeout(5000),
      }),
      prisma.$queryRaw`SELECT 1`,
      redis.ping(),
    ]);

    const services = {
      supabase:
        authCheck.status === "fulfilled" && authCheck.value.ok ? "up" : "down",
      postgres: postgresCheck.status === "fulfilled" ? "up" : "down",
      redis: redisCheck.status === "fulfilled" ? "up" : "down",
    };
    const healthy = Object.values(services).every((status) => status === "up");

    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "error",
      instance: env.instanceId,
      ...services,
    });
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
  try {
    await getIO().close();
  } catch {
    // IO is already absent during startup failures.
  }
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
