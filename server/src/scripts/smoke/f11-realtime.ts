import {
  assertEqual,
  ensureProfiles,
  expectOk,
  gql,
  redis,
  resetData,
  socketClient,
  step,
} from "./helpers.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(
  response: Awaited<ReturnType<typeof gql>>,
  objectName: string,
  fieldName: string
): unknown {
  const object = response.data?.[objectName];
  if (!isRecord(object)) throw new Error(`${objectName} was not returned.`);
  return object[fieldName];
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(): Promise<void> {
  await resetData();
  await ensureProfiles();

  await gql("alice", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');
  await gql("bob", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');
  await gql("carol", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');

  if (
    !(await step("Socket.IO rejects missing and bad tokens", async () => {
      const missing = await socketClient(null);
      const missingError = await missing.once<{ message: string }>("connect_error");
      assertEqual(missingError.message, "UNAUTHENTICATED", "missing token");
      await missing.close();

      const bad = await socketClient(null, "bad-token");
      const badError = await bad.once<{ message: string }>("connect_error");
      assertEqual(badError.message, "UNAUTHENTICATED", "bad token");
      await bad.close();
    }))
  ) return;

  const aliceMe = await gql("alice", "{ me { id } }");
  expectOk(aliceMe);
  const aliceId = field(aliceMe, "me", "id");
  if (typeof aliceId !== "string") throw new Error("Alice id was not returned.");

  let aliceOne: Awaited<ReturnType<typeof socketClient>> | null = null;
  let aliceTwo: Awaited<ReturnType<typeof socketClient>> | null = null;
    if (
      !(await step("alice receives ready and ping acknowledgement", async () => {
        aliceOne = await socketClient("alice");
        const ready = await aliceOne.once<{ userId: string; instance: string }>("ready");
        assertEqual(ready.userId, aliceId, "ready userId");
        const ping = await aliceOne.emitAck<{ pong: boolean; instance: string }>(
          "ping:test",
          {}
        );
        assertEqual(ping.pong, true, "ping pong");
      }))
    ) return;

    if (
      !(await step("presence counts connections and heartbeats", async () => {
        await wait(200);
        const firstCount = await redis.get(`presence:conn:${aliceId}`);
        assertEqual(firstCount, "1", "first presence count");
        const ttl = await redis.ttl(`presence:conn:${aliceId}`);
        assertEqual(ttl >= 1 && ttl <= 90, true, "first presence TTL");

        aliceTwo = await socketClient("alice");
        await aliceTwo.once<{ userId: string }>("ready");
        await wait(200);
        const secondCount = await redis.get(`presence:conn:${aliceId}`);
        assertEqual(secondCount, "2", "second presence count");

        await aliceOne?.close();
        await wait(300);
        const remaining = await redis.get(`presence:conn:${aliceId}`);
        assertEqual(remaining, "1", "presence after first disconnect");
        await aliceTwo.close();
        await wait(300);
        const removed = await redis.get(`presence:conn:${aliceId}`);
        assertEqual(removed, null, "presence key removed");
        const lastSeen = await redis.get(`presence:lastseen:${aliceId}`);
        assertEqual(typeof lastSeen, "string", "last-seen is set");
      }))
    ) return;

    if (
      !(await step("presence visibility follows accepted followers", async () => {
        const followed = await gql(
          "bob",
          'mutation { follow(username: "alice") { id } }'
        );
        expectOk(followed);

        aliceOne = await socketClient("alice");
        await aliceOne.once<{ userId: string }>("ready");
        await wait(200);

        const bobPresence = await gql(
          "bob",
          '{ presence(username: "alice") { isOnline lastSeenAt } }'
        );
        expectOk(bobPresence);
        assertEqual(
          field(bobPresence, "presence", "isOnline"),
          true,
          "Bob sees Alice online"
        );

        const carolPresence = await gql(
          "carol",
          '{ presence(username: "alice") { isOnline lastSeenAt } }'
        );
        expectOk(carolPresence);
        assertEqual(
          field(carolPresence, "presence", "isOnline"),
          false,
          "Carol does not see Alice online"
        );
        assertEqual(
          field(carolPresence, "presence", "lastSeenAt"),
          null,
          "Carol does not see lastSeen"
        );

        await aliceOne.close();
      }))
    ) return;
}
