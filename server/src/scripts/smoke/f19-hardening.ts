import { execSync, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ApolloServer } from "@apollo/server";
import { prisma } from "../../config/db.js";
import { typeDefs, resolvers } from "../../graphql/schema.js";
import {
  assertEqual,
  ensureProfiles,
  expectError,
  expectOk,
  gql,
  poll,
  redis,
  resetData,
  step,
} from "./helpers.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function ensureWindowHeadroom(minSecondsRemaining = 15): Promise<void> {
  const currentSec = Math.floor(Date.now() / 1000) % 60;
  if (60 - currentSec < minSecondsRemaining) {
    const waitMs = (61 - currentSec) * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

export async function run(): Promise<void> {
  await resetData();
  await ensureProfiles();

  const alice = await gql("alice", "{ me { id } }");
  const bob = await gql("bob", "{ me { id } }");
  expectOk(alice);
  expectOk(bob);
  const aliceId =
    alice.data?.me && isRecord(alice.data.me) ? String(alice.data.me.id) : null;
  const bobId =
    bob.data?.me && isRecord(bob.data.me) ? String(bob.data.me.id) : null;
  if (!aliceId || !bobId) {
    throw new Error("Could not get alice or bob ids.");
  }

  // Create a post by alice for commenting tests
  const post = await prisma.post.create({
    data: {
      authorId: aliceId,
      caption: "F19 hardening post",
    },
  });

  // 1. addComment 31 times in a minute -> 31st fails with RATE_LIMITED
  if (
    !(await step(
      "addComment is rate-limited to 30 per minute per user",
      async () => {
        // Ensure we have at least 15s left in current minute window
        await ensureWindowHeadroom(15);

        // Send 30 comments in parallel batches of 10
        const batchSize = 10;
        for (let i = 0; i < 30; i += batchSize) {
          const promises = Array.from({ length: batchSize }, (_, idx) =>
            gql(
              "bob",
              "mutation AddComment($postId: ID!, $body: String!) { addComment(postId: $postId, body: $body) { id } }",
              { postId: post.id, body: `Comment batch ${i + idx + 1}` }
            )
          );
          const results = await Promise.all(promises);
          for (const res of results) {
            expectOk(res);
          }
        }

        // 31st call must be blocked
        const blockedRes = await gql(
          "bob",
          "mutation AddComment($postId: ID!, $body: String!) { addComment(postId: $postId, body: $body) { id } }",
          { postId: post.id, body: "Comment number 31" }
        );
        expectError(blockedRes, "RATE_LIMITED");

        const keys = await redis.keys(`rl:addComment:${bobId}:*`);
        if (keys.length === 0) {
          throw new Error("Redis rl: key was not found for addComment rate limit.");
        }
        const ttl = await redis.ttl(keys[0]);
        if (ttl <= 0 || ttl > 60) {
          throw new Error(`Expected TTL between 1 and 60 for rate limit key, got ${ttl}.`);
        }
      }
    ))
  ) {
    return;
  }

  // 2. Send 301 requests quickly to /graphql: the later ones return HTTP 429
  if (
    !(await step(
      "HTTP endpoint is rate-limited to 300 per minute per IP",
      async () => {
        await ensureWindowHeadroom(15);

        // Clear rl:http:* keys first so earlier test steps don't offset the count
        const initialHttpKeys = await redis.keys("rl:http:*");
        if (initialHttpKeys.length > 0) {
          await redis.del(...initialHttpKeys);
        }

        const serverUrl =
          process.env.SERVER_URL ?? "http://localhost:4000/graphql";

        const sendReq = () =>
          fetch(serverUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: "{ hello }" }),
          });

        const batchSize = 50;
        for (let i = 0; i < 300; i += batchSize) {
          const batch = Array.from({ length: batchSize }, sendReq);
          const results = await Promise.all(batch);
          for (const res of results) {
            assertEqual(res.status, 200, "Expected HTTP 200 within limit");
          }
        }

        // 301st request should be rate-limited
        const blocked = await sendReq();
        assertEqual(blocked.status, 429, "Expected HTTP 429 for 301st request");
        const retryAfter = blocked.headers.get("retry-after");
        if (!retryAfter) {
          throw new Error("Expected Retry-After header on 429 response.");
        }
        const body = (await blocked.json()) as Record<string, unknown>;
        const errors = body.errors as Array<{ extensions?: { code?: string } }>;
        assertEqual(
          errors?.[0]?.extensions?.code,
          "RATE_LIMITED",
          "HTTP 429 error code"
        );

        // Clear rl:http:* keys again so subsequent requests are not blocked
        const cleanupHttpKeys = await redis.keys("rl:http:*");
        if (cleanupHttpKeys.length > 0) {
          await redis.del(...cleanupHttpKeys);
        }
      }
    ))
  ) {
    return;
  }

  // 3. Query nested deeper than 8 levels is rejected by validation
  if (
    !(await step(
      "queries deeper than 8 levels are rejected by validationRules",
      async () => {
        const deepQuery = `query Deep {
        post(id: "${post.id}") {
          comments {
            items {
              post {
                comments {
                  items {
                    post {
                      comments {
                        items {
                          post {
                            id
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`;

        const res = await gql("alice", deepQuery);
        if (!res.errors || res.errors.length === 0) {
          throw new Error("Expected deep query to fail validation, but it succeeded.");
        }
        const code = res.errors[0]?.extensions?.code;
        const msg = res.errors[0]?.message ?? "";
        const isValidationFailure =
          code === "GRAPHQL_VALIDATION_FAILED" ||
          msg.toLowerCase().includes("depth") ||
          msg.toLowerCase().includes("exceeds");
        if (!isValidationFailure) {
          throw new Error(
            `Expected depth validation failure, received: ${res.errors[0].message} (code: ${code})`
          );
        }
      }
    ))
  ) {
    return;
  }

  // 4. Introspection works in development; unit check confirms disabled in production
  if (
    !(await step(
      "introspection is enabled in development and disabled in production",
      async () => {
        const devRes = await gql("alice", "{ __schema { types { name } } }");
        expectOk(devRes);
        const types = (devRes.data as { __schema?: { types?: unknown[] } })
          ?.__schema?.types;
        if (!Array.isArray(types) || types.length === 0) {
          throw new Error("Expected __schema to return types in development.");
        }

        const prodServer = new ApolloServer({
          typeDefs,
          resolvers,
          introspection: false,
        });
        await prodServer.start();
        try {
          const prodRes = await prodServer.executeOperation({
            query: "{ __schema { types { name } } }",
          });
          if (prodRes.body.kind !== "single") {
            throw new Error("Expected single result from executeOperation.");
          }
          const errors = prodRes.body.singleResult.errors;
          if (!errors || errors.length === 0) {
            throw new Error(
              "Expected introspection query to be rejected when introspection is disabled."
            );
          }
          assertEqual(
            errors[0].extensions?.code,
            "GRAPHQL_VALIDATION_FAILED",
            "production introspection validation failure"
          );
        } finally {
          await prodServer.stop();
        }
      }
    ))
  ) {
    return;
  }

  // 5. Forced internal error returns masked message with request id and no stack trace
  if (
    !(await step(
      "internal errors are masked with INTERNAL_SERVER_ERROR and a request id",
      async () => {
        const res = await gql("alice", "{ _forceError }");
        if (!res.errors || res.errors.length === 0) {
          throw new Error("Expected _forceError to throw an error.");
        }
        const err = res.errors[0];
        assertEqual(err.message, "Internal server error.", "masked error message");
        assertEqual(
          err.extensions?.code,
          "INTERNAL_SERVER_ERROR",
          "error code"
        );

        const serverUrl =
          process.env.SERVER_URL ?? "http://localhost:4000/graphql";
        const rawRes = await fetch(serverUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "{ _forceError }" }),
        });
        const rawJson = (await rawRes.json()) as {
          errors?: Array<{
            message: string;
            extensions?: Record<string, unknown>;
          }>;
        };
        const rawErr = rawJson.errors?.[0];
        const requestId = rawErr?.extensions?.requestId;
        if (typeof requestId !== "string" || !requestId) {
          throw new Error("Expected requestId string in error extensions.");
        }
        if (rawErr?.extensions?.stacktrace !== undefined) {
          throw new Error("Stack trace should not be exposed in error extensions.");
        }
      }
    ))
  ) {
    return;
  }

  // 6. Helmet headers on /health; /ready returns 200, and 503 when Redis is stopped
  if (
    !(await step(
      "health endpoints return helmet headers and correct readiness status",
      async () => {
        const healthUrl = "http://localhost:4000/health";
        const readyUrl = "http://localhost:4000/ready";

        const healthRes = await fetch(healthUrl);
        assertEqual(healthRes.status, 200, "health endpoint status");
        const contentTypeOptions = healthRes.headers.get("x-content-type-options");
        if (contentTypeOptions !== "nosniff") {
          throw new Error(
            `Expected helmet x-content-type-options header to be 'nosniff', got '${contentTypeOptions}'`
          );
        }

        const readyRes = await fetch(readyUrl);
        assertEqual(readyRes.status, 200, "ready endpoint status");
        const readyBody = (await readyRes.json()) as Record<string, unknown>;
        assertEqual(readyBody.status, "ready", "ready body status");
        assertEqual(readyBody.redis, "up", "ready body redis");
        assertEqual(readyBody.postgres, "up", "ready body postgres");

        const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
        const isLocalRedis =
          process.env.REDIS_URL?.includes("localhost") ||
          process.env.REDIS_URL?.includes("127.0.0.1");

        if (isLocalRedis) {
          try {
            execSync("docker compose stop -t 1 redis", { cwd: rootDir, stdio: "ignore" });
            let unreadyStatus = 200;
            let unreadyBody: Record<string, unknown> = {};
            await poll(
              "ready endpoint reports 503 after redis is stopped",
              async () => {
                const res = await fetch(readyUrl);
                unreadyStatus = res.status;
                unreadyBody = (await res.json()) as Record<string, unknown>;
                return unreadyStatus === 503;
              },
              10000
            );
            assertEqual(unreadyStatus, 503, "ready endpoint status when redis is down");
            assertEqual(unreadyBody.status, "not_ready", "unready body status");
            assertEqual(unreadyBody.redis, "down", "unready body redis");
            const livenessDuringRedisOutage = await fetch(healthUrl);
            assertEqual(
              livenessDuringRedisOutage.status,
              200,
              "liveness remains healthy when redis is down"
            );
          } finally {
            execSync("docker compose start redis", { cwd: rootDir, stdio: "ignore" });
            await poll(
              "redis reconnected",
              async () => {
                try {
                  return (await redis.ping()) === "PONG";
                } catch {
                  return false;
                }
              },
              15000
            );
          }
        } else {
          const unreadyRes = await fetch(`${readyUrl}?simulate=redis_down`);
          assertEqual(unreadyRes.status, 503, "ready endpoint status when redis is down");
          const unreadyBody = (await unreadyRes.json()) as Record<string, unknown>;
          assertEqual(unreadyBody.status, "not_ready", "unready body status");
          assertEqual(unreadyBody.redis, "down", "unready body redis");
          const livenessDuringRedisOutage = await fetch(healthUrl);
          assertEqual(
            livenessDuringRedisOutage.status,
            200,
            "liveness remains healthy when redis is down"
          );
        }
      }
    ))
  ) {
    return;
  }

  // 7. Send SIGTERM to the server: logs each shutdown step and exits with code 0
  if (
    !(await step(
      "graceful shutdown logs all steps and exits cleanly",
      async () => {
        const scriptDir = dirname(fileURLToPath(import.meta.url));
        const serverDir = join(scriptDir, "..", "..", "..");
        const serverPath = join(serverDir, "src", "server.ts");

        const outputLines: string[] = [];
        const child = fork(serverPath, [], {
          cwd: serverDir,
          execArgv: ["--import", "tsx", "--env-file=.env"],
          env: {
            ...process.env,
            PORT: "4009",
            NODE_ENV: "development",
          },
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        });

        child.stdout?.on("data", (chunk: Buffer) => {
          outputLines.push(chunk.toString());
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          outputLines.push(chunk.toString());
        });

        await poll(
          "child server started on port 4009",
          async () => {
            try {
              const res = await fetch("http://localhost:4009/health");
              return res.status === 200;
            } catch {
              return false;
            }
          },
          15000
        );

        const exitPromise = new Promise<{ code: number | null }>((resolve) => {
          child.once("exit", (code) => resolve({ code }));
        });

        child.send("SIGTERM");
        const { code } = await exitPromise;
        if (child.connected) child.disconnect();

        assertEqual(code, 0, "child server exit code");
        const fullOutput = outputLines.join("\n");
        const requiredSteps = [
          "Shutdown step 1: stop accepting HTTP",
          "Shutdown step 2: close Socket.IO",
          "Shutdown step 3: stop Apollo",
          "Shutdown step 4: close BullMQ queues",
          "Shutdown step 5: close Redis",
          "Shutdown step 6: disconnect Prisma",
          "Shutdown complete",
        ];

        for (const stepMsg of requiredSteps) {
          if (!fullOutput.includes(stepMsg)) {
            throw new Error(
              `Expected shutdown log to include '${stepMsg}', output was:\n${fullOutput}`
            );
          }
        }
      }
    ))
  ) {
    return;
  }
}
