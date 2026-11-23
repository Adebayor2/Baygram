import { prisma } from "../../config/db.js";
import { redis } from "../../config/redis.js";
import {
  sendToUser,
  setPushSender,
} from "../../modules/push/service.js";
import { notificationPushPayload } from "../../modules/notifications/service.js";
import {
  assertEqual,
  ensureProfiles,
  expectOk,
  gql,
  resetData,
  step,
} from "./helpers.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function run(): Promise<void> {
  await resetData();
  await ensureProfiles();

  await step("VAPID key and push subscription ownership", async () => {
    const key = await gql("alice", "{ vapidPublicKey }");
    expectOk(key);
    assertEqual(
      typeof key.data?.vapidPublicKey === "string" &&
        key.data.vapidPublicKey.length > 0,
      true,
      "VAPID public key is available"
    );

    const input = {
      endpoint: `https://push.invalid/f17-${process.pid}`,
      p256dh: "fake-p256dh",
      auth: "fake-auth",
      userAgent: "F17 smoke",
    };
    for (let index = 0; index < 2; index += 1) {
      const registered = await gql(
        "alice",
        "mutation Register($input: PushSubscriptionInput!) { registerPushSubscription(input: $input) }",
        { input }
      );
      expectOk(registered);
    }
    const rows = await prisma.pushSubscription.count({ where: { endpoint: input.endpoint } });
    assertEqual(rows, 1, "registering twice leaves one row");

    const moved = await gql(
      "bob",
      "mutation Register($input: PushSubscriptionInput!) { registerPushSubscription(input: $input) }",
      { input }
    );
    expectOk(moved);
    const ownedByBob = await prisma.pushSubscription.findUnique({
      where: { endpoint: input.endpoint },
    });
    const ownerCheck = await gql("bob", "{ me { id } }");
    const ownerData = isRecord(ownerCheck.data?.me) ? ownerCheck.data.me : null;
    assertEqual(ownedByBob?.userId, ownerData?.id, "endpoint moves ownership");

    const removed = await gql(
      "bob",
      "mutation Remove($endpoint: String!) { unregisterPushSubscription(endpoint: $endpoint) }",
      { endpoint: input.endpoint }
    );
    expectOk(removed);
    assertEqual(
      await prisma.pushSubscription.count({ where: { endpoint: input.endpoint } }),
      0,
      "unregister removes subscription"
    );
  });

  await step("410 subscriptions are removed and success is sent once", async () => {
    const bob = await gql("bob", "{ me { id } }");
    const bobProfile = isRecord(bob.data?.me) ? bob.data.me : null;
    const bobId = typeof bobProfile?.id === "string" ? bobProfile.id : null;
    if (typeof bobId !== "string") throw new Error("Bob id missing.");

    await prisma.pushSubscription.create({
      data: {
        userId: bobId,
        endpoint: `https://push.invalid/410-${process.pid}`,
        p256dh: "fake-p256dh",
        auth: "fake-auth",
      },
    });
    let calls = 0;
    setPushSender(async () => {
      calls += 1;
      throw { statusCode: 410 };
    });
    await sendToUser(bobId, {
      title: "test",
      body: "test",
      url: "/",
      icon: "",
      tag: "test",
    });
    assertEqual(calls, 1, "410 sender called once");
    assertEqual(
      await prisma.pushSubscription.count({
        where: { userId: bobId, endpoint: `https://push.invalid/410-${process.pid}` },
      }),
      0,
      "410 subscription deleted"
    );

    await prisma.pushSubscription.create({
      data: {
        userId: bobId,
        endpoint: `https://push.invalid/success-${process.pid}`,
        p256dh: "fake-p256dh",
        auth: "fake-auth",
      },
    });
    calls = 0;
    setPushSender(async () => {
      calls += 1;
    });
    await sendToUser(bobId, {
      title: "test",
      body: "test",
      url: "/",
      icon: "",
      tag: "test",
    });
    assertEqual(calls, 1, "successful sender called once");
  });

  await step("offline rule skips connected users", async () => {
    const bob = await gql("bob", "{ me { id } }");
    const bobProfile = isRecord(bob.data?.me) ? bob.data.me : null;
    const bobId = typeof bobProfile?.id === "string" ? bobProfile.id : null;
    if (typeof bobId !== "string") throw new Error("Bob id missing.");
    await redis.set(`presence:conn:${bobId}`, "1");
    let calls = 0;
    setPushSender(async () => {
      calls += 1;
    });
    await sendToUser(bobId, {
      title: "offline",
      body: "only",
      url: "/",
      icon: "",
      tag: "offline",
    });
    assertEqual(calls, 0, "no push while presence exists");
    await redis.del(`presence:conn:${bobId}`);
    await sendToUser(bobId, {
      title: "offline",
      body: "now",
      url: "/",
      icon: "",
      tag: "offline",
    });
    assertEqual(calls, 1, "push sent after presence removed");
  });

  await step("LIKE notification payload text", async () => {
    const payload = notificationPushPayload(
      {
        type: "LIKE",
        recipientId: "00000000-0000-4000-8000-000000000001",
        actorId: "00000000-0000-4000-8000-000000000002",
        postId: "00000000-0000-4000-8000-000000000003",
      },
      { username: "bob", avatarUrl: null }
    );
    assertEqual(payload.title, "bob liked your post", "LIKE push title");
    assertEqual(payload.body, "bob liked your post", "LIKE push body");
  });
}
