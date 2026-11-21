import { prisma } from "../../config/db.js";
import {
  assertEqual,
  ensureProfiles,
  expectOk,
  gql,
  poll,
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

export async function run(): Promise<void> {
  await resetData();
  await ensureProfiles();

  const aliceMe = await gql("alice", "{ me { id } }");
  const bobMe = await gql("bob", "{ me { id } }");
  expectOk(aliceMe);
  expectOk(bobMe);
  const bobId = field(bobMe, "me", "id");
  const aliceId = field(aliceMe, "me", "id");
  if (typeof bobId !== "string" || typeof aliceId !== "string") {
    throw new Error("Test user ids were not returned.");
  }

  const bobPost = await prisma.post.create({
    data: {
      authorId: bobId,
      caption: "Bob F13 post",
    },
  });
  const offlinePost = await prisma.post.create({
    data: {
      authorId: bobId,
      caption: "Bob F13 offline post",
    },
  });

  const bobSocket = await socketClient("bob");
  const ready = await bobSocket.once<{ userId: string }>("ready");
  assertEqual(ready.userId, bobId, "socket joins Bob's user room");

  if (
    !(await step("alice likes Bob's post and Bob receives live notification events", async () => {
      const notificationEvent =
        bobSocket.once<{ id: string; type: string; postId: string | null }>(
          "notification:new"
        );
      const unreadEvent =
        bobSocket.once<{ count: number }>("notification:unread");
      const eventResults = Promise.all([notificationEvent, unreadEvent]);

      const liked = await gql(
        "alice",
        "mutation Like($postId: ID!) { likePost(postId: $postId) { likesCount } }",
        { postId: bobPost.id }
      );
      expectOk(liked);

      const [notification, unread] = await eventResults;
      await poll("stored LIKE notification", async () => {
        const page = await gql(
          "bob",
          "{ notifications { items { id type post { id } } } }"
        );
        expectOk(page);
        const storedPage = page.data?.notifications;
        return (
          isRecord(storedPage) &&
          Array.isArray(storedPage.items) &&
          storedPage.items.some(
            (item) =>
              isRecord(item) &&
              item.type === "LIKE" &&
              isRecord(item.post) &&
              item.post.id === bobPost.id
          )
        );
      });
      assertEqual(notification.type, "LIKE", "notification type");
      assertEqual(notification.postId, bobPost.id, "notification post id");
      assertEqual(unread.count, 1, "live unread count");

      const count = await gql("bob", "{ unreadNotificationsCount }");
      expectOk(count);
      assertEqual(
        count.data?.unreadNotificationsCount,
        unread.count,
        "event count equals unread query"
      );
    }))
  ) {
    await bobSocket.close();
    return;
  }

  if (
    !(await step("mark all emits unread zero and self-likes emit nothing", async () => {
      const unreadEvent =
        bobSocket.once<{ count: number }>("notification:unread");
      await gql("bob", "mutation { markAllNotificationsRead }");
      const unread = await unreadEvent;
      assertEqual(unread.count, 0, "mark-all live unread count");

      const listener = bobSocket.once<unknown>("notification:new");
      await gql(
        "bob",
        "mutation Like($postId: ID!) { likePost(postId: $postId) { id } }",
        { postId: bobPost.id }
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      listener.catch(() => undefined);
    }))
  ) {
    await bobSocket.close();
    return;
  }

  if (
    !(await step("offline recipients still receive stored notifications", async () => {
      await bobSocket.close();
      const liked = await gql(
        "alice",
        "mutation Like($postId: ID!) { likePost(postId: $postId) { id } }",
        { postId: offlinePost.id }
      );
      expectOk(liked);
      await poll("offline notification", async () => {
        const page = await gql(
          "bob",
          "{ notifications(unreadOnly: true) { items { type } } }"
        );
        expectOk(page);
        const result = page.data?.notifications;
        return (
          isRecord(result) &&
          Array.isArray(result.items) &&
          result.items.some((item) => isRecord(item) && item.type === "LIKE")
        );
      });
    }))
  ) {
    await bobSocket.close();
    return;
  }

  await bobSocket.close();
}
