import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../../config/db.js";
import { redis } from "../../config/redis.js";
import { supabase } from "../../config/supabase.js";
import { io as createSocket, type Socket } from "socket.io-client";

interface TestUser {
  email: string;
  password: string;
}

interface SmokeError {
  message: string;
  extensions?: { code?: string };
}

export interface SmokeResponse {
  data: Record<string, unknown> | null;
  errors?: SmokeError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadTestUsers(): Record<string, TestUser> {
  const file = join(process.cwd(), "test-users.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read ${file}; create it with alice, bob, and carol credentials.`,
      { cause: error }
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("test-users.json must contain an object of test users.");
  }

  const users: Record<string, TestUser> = {};
  for (const name of ["alice", "bob", "carol"]) {
    const user = parsed[name];
    if (
      !isRecord(user) ||
      typeof user.email !== "string" ||
      !user.email ||
      typeof user.password !== "string" ||
      !user.password ||
      user.password.startsWith("REPLACE_")
    ) {
      throw new Error(
        `test-users.json needs a real email and password for ${name}.`
      );
    }
    users[name] = { email: user.email, password: user.password };
  }
  return users;
}

const testUsers = loadTestUsers();
const tokens = new Map<string, string>();
let smokeQueues: typeof import("../../config/queues.js") | null = null;

export async function login(name: string): Promise<string> {
  const cached = tokens.get(name);
  if (cached) return cached;

  const user = testUsers[name];
  if (!user) throw new Error(`Unknown test user "${name}".`);

  const { data, error } = await supabase.auth.signInWithPassword(user);
  if (error || !data.session?.access_token) {
    throw new Error(
      `Could not sign in test user "${name}": ${error?.message ?? "No access token returned."}`
    );
  }

  const token = data.session.access_token;
  tokens.set(name, token);
  return token;
}

async function tokenFor(who: string | null): Promise<string | null> {
  if (who === null) return null;
  return Object.prototype.hasOwnProperty.call(testUsers, who)
    ? login(who)
    : who;
}

export async function gql(
  who: string | null,
  query: string,
  variables?: Record<string, unknown>
): Promise<SmokeResponse> {
  const token = await tokenFor(who);
  const response = await fetch(
    process.env.SERVER_URL ?? "http://localhost:4000/graphql",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error(
      `GraphQL returned an invalid response (HTTP ${response.status}).`
    );
  }

  const errors = Array.isArray(payload.errors)
    ? payload.errors.map((error): SmokeError => {
        if (!isRecord(error) || typeof error.message !== "string") {
          throw new Error("GraphQL returned a malformed error.");
        }
        const extensions = isRecord(error.extensions)
          ? {
              code:
                typeof error.extensions.code === "string"
                  ? error.extensions.code
                  : undefined,
            }
          : undefined;
        return { message: error.message, extensions };
      })
    : undefined;

  return {
    data: isRecord(payload.data) ? payload.data : null,
    ...(errors ? { errors } : {}),
  };
}

export function expectOk(response: SmokeResponse): void {
  if (response.errors?.length) {
    throw new Error(response.errors[0].message);
  }
}

export function expectError(response: SmokeResponse, code: string): void {
  const actual = response.errors?.[0]?.extensions?.code;
  if (actual !== code) {
    throw new Error(
      `Expected error code ${code}, received ${actual ?? "no error"}.`
    );
  }
}

export function assertEqual(
  actual: unknown,
  expected: unknown,
  label: string
): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`
    );
  }
}

export async function poll(
  title: string,
  fn: () => Promise<boolean>,
  timeoutMs = 5000
): Promise<boolean> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (lastError) throw lastError;
  throw new Error(`Timed out polling ${title}.`);
}

export async function step(
  title: string,
  fn: () => Promise<void>
): Promise<boolean> {
  try {
    await fn();
    console.log(`PASS ${title}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL ${title}: ${message}`);
    process.exitCode = 1;
    return false;
  }
}

export async function ensureProfiles(): Promise<void> {
  for (const name of ["alice", "bob", "carol"]) {
    const current = await gql(name, "{ me { id username } }");
    expectOk(current);
    if (current.data?.me) continue;

    const created = await gql(
      name,
      "mutation CreateProfile($username: String!, $fullName: String) { createProfile(username: $username, fullName: $fullName) { id username } }",
      { username: name, fullName: name }
    );
    expectOk(created);
  }
}

async function testUserIds(): Promise<string[]> {
  const ids: string[] = [];
  for (const name of ["alice", "bob", "carol"]) {
    const token = await login(name);
    const { data, error } = await supabase.auth.getClaims(token);
    const id = data?.claims?.sub;
    if (error || typeof id !== "string") {
      throw new Error(`Could not determine the Supabase user id for ${name}.`);
    }
    ids.push(id);
  }
  return ids;
}

export async function resetData(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("resetData() refuses to run when NODE_ENV is production.");
  }

  const ids = await testUserIds();
  if (!smokeQueues) {
    smokeQueues = await import("../../config/queues.js");
  }
  const notificationJobs = await smokeQueues.notificationQueue.getJobs([
    "waiting",
    "delayed",
    "completed",
    "failed",
  ]);
  await Promise.all(
    notificationJobs
      .filter(
        (job) =>
          isRecord(job.data) &&
          (ids.includes(String(job.data.actorId)) ||
            ids.includes(String(job.data.recipientId)))
      )
      .map((job) => job.remove())
  );

  await prisma.follow.deleteMany({
    where: {
      OR: [{ followerId: { in: ids } }, { followingId: { in: ids } }],
    },
  });
  await prisma.block.deleteMany({
    where: {
      OR: [{ blockerId: { in: ids } }, { blockedId: { in: ids } }],
    },
  });
  await prisma.notification.deleteMany({
    where: {
      OR: [{ recipientId: { in: ids } }, { actorId: { in: ids } }],
    },
  });
  await prisma.story.deleteMany({
    where: { authorId: { in: ids } },
  });
  await prisma.pushSubscription.deleteMany({
    where: { userId: { in: ids } },
  });
  await prisma.callLog.deleteMany({
    where: {
      OR: [{ callerId: { in: ids } }, { calleeId: { in: ids } }],
    },
  });
  await prisma.conversation.deleteMany({});
  await prisma.post.deleteMany({
    where: { authorId: { in: ids } },
  });
  await prisma.hashtag.deleteMany({});
  await prisma.profile.deleteMany({ where: { id: { in: ids } } });

  for (const prefix of ["cache:", "notif:", "chat:", "presence:", "rl:"]) {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        100
      );
      cursor = nextCursor;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
  }
  await redis.del("explore:trending", "explore:trending:tmp");
  let callCursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      callCursor,
      "MATCH",
      "call:*",
      "COUNT",
      100
    );
    callCursor = nextCursor;
    if (keys.length > 0) await redis.del(...keys);
  } while (callCursor !== "0");
}

export async function closeSmokeResources(): Promise<void> {
  if (smokeQueues) {
    await Promise.all([
      smokeQueues.notificationQueue.close(),
      smokeQueues.mediaQueue.close(),
      smokeQueues.maintenanceQueue.close(),
      smokeQueues.pushQueue.close(),
      smokeQueues.callsQueue.close(),
    ]);
    await smokeQueues.bullRedis.quit();
    smokeQueues = null;
  }
  await Promise.all([redis.quit(), prisma.$disconnect()]);
}

export { redis };

export interface SmokeSocket {
  socket: Socket;
  once<T>(event: string): Promise<T>;
  emitAck<T>(event: string, payload?: unknown): Promise<T>;
  close(): Promise<void>;
}

export async function socketClient(
  name: string | null,
  rawToken?: string
): Promise<SmokeSocket> {
  const token =
    rawToken ??
    (name ? (Object.prototype.hasOwnProperty.call(testUsers, name) ? await login(name) : name) : null);
  const socket = createSocket(
    process.env.SOCKET_URL ?? "http://localhost:4000",
    {
      transports: ["websocket"],
      auth: token ? { token } : {},
      reconnection: false,
    }
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for socket ready.")),
      5000
    );
    socket.once("ready", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  return {
    socket,
    once<T>(event: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for socket event "${event}".`)),
          8000
        );
        socket.once(event, (value: T) => {
          clearTimeout(timeout);
          resolve(value);
        });
      });
    },
    emitAck<T>(event: string, payload?: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(`Timed out waiting for acknowledgement "${event}".`)
            ),
          5000
        );
        socket.emit(event, payload, (value: T) => {
          clearTimeout(timeout);
          resolve(value);
        });
      });
    },
    close(): Promise<void> {
      socket.disconnect();
      return Promise.resolve();
    },
  };
}
