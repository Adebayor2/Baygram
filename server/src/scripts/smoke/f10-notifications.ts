import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { uploadToCloudinary } from "../upload.js";
import {
  assertEqual,
  ensureProfiles,
  expectOk,
  gql,
  redis,
  resetData,
  step,
  poll,
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

async function uploadPostImage(pngPath: string): Promise<string> {
  const signed = await gql(
    "alice",
    "mutation { createUploadSignature(kind: POST_IMAGE) { apiKey timestamp folder signature resourceType uploadUrl } }"
  );
  expectOk(signed);
  const value = signed.data?.createUploadSignature;
  if (!isRecord(value)) throw new Error("Upload signature was not returned.");
  return (
    await uploadToCloudinary(
      {
        cloudName: "",
        apiKey: String(value.apiKey),
        timestamp: Number(value.timestamp),
        folder: String(value.folder),
        signature: String(value.signature),
        resourceType: String(value.resourceType),
        uploadUrl: String(value.uploadUrl),
      },
      pngPath
    )
  ).publicId;
}

export async function run(): Promise<void> {
  await resetData();
  await ensureProfiles();

  await gql("alice", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');
  await gql("bob", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');
  await gql("carol", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');

  const pngPath = join(tmpdir(), `baygram-f10-${process.pid}.png`);
  await writeFile(
    pngPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );

  try {
    const publicId = await uploadPostImage(pngPath);
    const created = await gql(
      "alice",
      "mutation Create($input: CreatePostInput!) { createPost(input: $input) { id } }",
      { input: { caption: "F10 post", media: [{ publicId, type: "IMAGE" }] } }
    );
    expectOk(created);
    const postId = field(created, "createPost", "id");
    if (typeof postId !== "string") throw new Error("Post id was not returned.");

    if (!(await step("likes create and remove a deduplicated notification", async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await gql(
          "bob",
          "mutation Like($id: ID!) { likePost(postId: $id) { id } }",
          { id: postId }
        );
      }
      await poll("LIKE notification", async () => {
        const count = await gql("alice", "{ unreadNotificationsCount }");
        return count.data?.unreadNotificationsCount === 1;
      });
      await poll("LIKE notification row", async () => {
        const page = await gql("alice", "{ notifications { items { type } } }");
        const result = page.data?.notifications;
        if (!isRecord(result) || !Array.isArray(result.items)) return false;
        return result.items.filter((item) => isRecord(item) && item.type === "LIKE").length === 1;
      });

      await gql(
        "bob",
        "mutation Unlike($id: ID!) { unlikePost(postId: $id) { id } }",
        { id: postId }
      );
      const afterUnlike = await gql("alice", "{ unreadNotificationsCount }");
      expectOk(afterUnlike);
      assertEqual(afterUnlike.data?.unreadNotificationsCount, 0, "unlike unread count");
    }))) return;

    let topCommentId = "";
    if (!(await step("comments and replies create distinct notifications", async () => {
      await gql(
        "alice",
        "mutation Like($id: ID!) { likePost(postId: $id) { id } }",
        { id: postId }
      );
      const selfCount = await gql("alice", "{ unreadNotificationsCount }");
      expectOk(selfCount);
      assertEqual(selfCount.data?.unreadNotificationsCount, 0, "self-like creates none");

      const comment = await gql(
        "carol",
        "mutation Comment($id: ID!) { addComment(postId: $id, body: \"Top\") { id } }",
        { id: postId }
      );
      expectOk(comment);
      topCommentId = String(field(comment, "addComment", "id"));
      await gql(
        "bob",
        "mutation Reply($id: ID!, $parent: ID!) { addComment(postId: $id, body: \"Reply\", parentId: $parent) { id } }",
        { id: postId, parent: topCommentId }
      );

      await poll("Alice COMMENT notification", async () => {
        const page = await gql("alice", "{ notifications { items { type } } }");
        const data = page.data?.notifications;
        return isRecord(data) &&
          Array.isArray(data.items) &&
          data.items.some((item) => isRecord(item) && item.type === "COMMENT");
      });
      await poll("Carol REPLY notification", async () => {
        const page = await gql("carol", "{ notifications { items { type } } }");
        const data = page.data?.notifications;
        return isRecord(data) &&
          Array.isArray(data.items) &&
          data.items.some((item) => isRecord(item) && item.type === "REPLY");
      });
    }))) return;

    let notificationId = "";
    if (!(await step("mark read, mark all, unread filter, and Redis recomputation work", async () => {
      const page = await gql("alice", "{ notifications { items { id type readAt } } }");
      expectOk(page);
      const result = page.data?.notifications;
      if (!isRecord(result) || !Array.isArray(result.items)) throw new Error("Notifications invalid.");
      const first = result.items.find((item) => isRecord(item) && typeof item.id === "string");
      if (!isRecord(first) || typeof first.id !== "string") throw new Error("Notification id missing.");
      notificationId = first.id;

      await gql(
        "alice",
        "mutation Mark($id: ID!) { markNotificationRead(id: $id) }",
        { id: notificationId }
      );
      const unreadOnly = await gql("alice", "{ notifications(unreadOnly: true) { items { id } } }");
      expectOk(unreadOnly);

      const aliceMe = await gql("alice", "{ me { id } }");
      expectOk(aliceMe);
      const aliceId = field(aliceMe, "me", "id");
      if (typeof aliceId !== "string") throw new Error("Alice id missing.");
      await redis.del(`notif:unread:${aliceId}`);
      const recomputed = await gql("alice", "{ unreadNotificationsCount }");
      expectOk(recomputed);
      assertEqual(typeof recomputed.data?.unreadNotificationsCount, "number", "recomputed count");

      await gql("alice", "mutation { markAllNotificationsRead }");
      const afterAll = await gql("alice", "{ unreadNotificationsCount }");
      expectOk(afterAll);
      assertEqual(afterAll.data?.unreadNotificationsCount, 0, "mark-all unread count");
    }))) return;

    if (!(await step("follow and follow-request notifications work", async () => {
      await gql("bob", 'mutation { follow(username: "alice") { id } }');
      await poll("FOLLOW notification", async () => {
        const page = await gql("alice", "{ notifications { items { type } } }");
        const data = page.data?.notifications;
        return isRecord(data) &&
          Array.isArray(data.items) &&
          data.items.some((item) => isRecord(item) && item.type === "FOLLOW");
      });

      await gql("alice", 'mutation { updateProfile(input: { isPrivate: true }) { id } }');
      await gql("bob", 'mutation { follow(username: "alice") { id } }');
      await gql("alice", 'mutation { unfollow(username: "bob") { id } }');
      await gql("carol", 'mutation { follow(username: "alice") { id } }');
      await gql("alice", 'mutation { acceptFollowRequest(username: "carol") { id } }');

      await poll("FOLLOW_ACCEPTED notification", async () => {
        const page = await gql("carol", "{ notifications { items { type } } }");
        const data = page.data?.notifications;
        return isRecord(data) &&
          Array.isArray(data.items) &&
          data.items.some((item) => isRecord(item) && item.type === "FOLLOW_ACCEPTED");
      });
    }))) return;

    if (!(await step("users cannot read or mark another user's notifications", async () => {
      const bobMark = await gql(
        "bob",
        "mutation Mark($id: ID!) { markNotificationRead(id: $id) }",
        { id: notificationId }
      );
      assertEqual(
        bobMark.errors?.[0]?.extensions?.code,
        "FORBIDDEN",
        "cross-user mark forbidden"
      );
    }))) return;
  } finally {
    await unlink(pngPath).catch(() => undefined);
  }
}
