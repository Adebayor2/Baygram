import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { uploadToCloudinary } from "../upload.js";
import {
  assertEqual,
  ensureProfiles,
  expectError,
  expectOk,
  gql,
  resetData,
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

async function uploadPng(userName: string, pngPath: string): Promise<string> {
  const signed = await gql(
    userName,
    "mutation { createUploadSignature(kind: POST_IMAGE) { cloudName apiKey timestamp folder signature resourceType uploadUrl } }"
  );
  expectOk(signed);
  const value = signed.data?.createUploadSignature;
  if (!isRecord(value)) throw new Error("Upload signature was not returned.");
  const signature = {
    cloudName: String(value.cloudName),
    apiKey: String(value.apiKey),
    timestamp: Number(value.timestamp),
    folder: String(value.folder),
    signature: String(value.signature),
    resourceType: String(value.resourceType),
    uploadUrl: String(value.uploadUrl),
  };
  return (await uploadToCloudinary(signature, pngPath)).publicId;
}

export async function run(): Promise<void> {
  await resetData();
  await ensureProfiles();

  const pngPath = join(tmpdir(), `baygram-post-${process.pid}.png`);
  await writeFile(
    pngPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );

  let postId = "";
  try {
    if (
      !(await step("create a two-image post and increment postsCount", async () => {
        await gql("alice", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');
        await gql("bob", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');
        await gql("carol", 'mutation { updateProfile(input: { isPrivate: true }) { id } }');

        const first = await uploadPng("alice", pngPath);
        const second = await uploadPng("alice", pngPath);
        const created = await gql(
          "alice",
          "mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { id caption media { publicId url type } likesCount commentsCount } }",
          {
            input: {
              caption: "Hello from BayGram",
              media: [
                { publicId: first, type: "IMAGE" },
                { publicId: second, type: "IMAGE" },
              ],
            },
          }
        );
        expectOk(created);
        postId = String(field(created, "createPost", "id"));
        const media = field(created, "createPost", "media");
        if (!Array.isArray(media) || media.length !== 2) throw new Error("Post did not contain two media items.");

        const me = await gql("alice", "{ me { postsCount } }");
        expectOk(me);
        assertEqual(field(me, "me", "postsCount"), 1, "Alice postsCount");
      }))
    ) {
      return;
    }

    if (
      !(await step("reject invalid post media and captions", async () => {
        const empty = await gql(
          "alice",
          'mutation { createPost(input: { media: [] }) { id } }'
        );
        expectError(empty, "BAD_USER_INPUT");

        const eleven = await gql(
          "alice",
          'mutation { createPost(input: { media: [' +
            Array.from({ length: 11 }, () => '{ publicId: "made-up", type: IMAGE }').join(", ") +
            '] }) { id } }'
        );
        expectError(eleven, "BAD_USER_INPUT");

        const longCaption = await gql(
          "alice",
          "mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { id } }",
          { input: { caption: "x".repeat(2201), media: [{ publicId: "made-up", type: "IMAGE" }] } }
        );
        expectError(longCaption, "BAD_USER_INPUT");

        const bobPublicId = await uploadPng("bob", pngPath);
        const bobMedia = await gql(
          "alice",
          "mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { id } }",
          { input: { media: [{ publicId: bobPublicId, type: "IMAGE" }] } }
        );
        expectError(bobMedia, "FORBIDDEN");
      }))
    ) {
      return;
    }

    if (
      !(await step("apply post visibility to userPosts", async () => {
        const bobPosts = await gql(
          "bob",
          'query { userPosts(username: "alice") { items { id } nextCursor } }'
        );
        expectOk(bobPosts);

        await gql(
          "alice",
          'mutation { follow(username: "carol") { id } }'
        );
        const hidden = await gql(
          "alice",
          'query { userPosts(username: "carol") { items { id } } }'
        );
        expectError(hidden, "FORBIDDEN");

        await gql(
          "carol",
          'mutation { acceptFollowRequest(username: "alice") { id } }'
        );
        const visible = await gql(
          "alice",
          'query { userPosts(username: "carol") { items { id } } }'
        );
        expectOk(visible);
      }))
    ) {
      return;
    }

    if (
      !(await step("only the author can edit or delete a post", async () => {
        const forbiddenEdit = await gql(
          "bob",
          "mutation Edit($postId: ID!) { updatePostCaption(postId: $postId, caption: \"No\") { id } }",
          { postId }
        );
        expectError(forbiddenEdit, "FORBIDDEN");

        const forbiddenDelete = await gql(
          "bob",
          "mutation Delete($postId: ID!) { deletePost(postId: $postId) }",
          { postId }
        );
        expectError(forbiddenDelete, "FORBIDDEN");

        const edited = await gql(
          "alice",
          "mutation Edit($postId: ID!) { updatePostCaption(postId: $postId, caption: \"Updated\") { caption } }",
          { postId }
        );
        expectOk(edited);
        assertEqual(field(edited, "updatePostCaption", "caption"), "Updated", "edited caption");

        const deleted = await gql(
          "alice",
          "mutation Delete($postId: ID!) { deletePost(postId: $postId) }",
          { postId }
        );
        expectOk(deleted);
        assertEqual(deleted.data?.deletePost, true, "delete result");

        const missing = await gql(
          "alice",
          "query Post($id: ID!) { post(id: $id) { id } }",
          { id: postId }
        );
        expectOk(missing);
        assertEqual(missing.data?.post, null, "deleted post");

        const me = await gql("alice", "{ me { postsCount } }");
        expectOk(me);
        assertEqual(field(me, "me", "postsCount"), 0, "postsCount after delete");
      }))
    ) {
      return;
    }

    if (
      !(await step("three posts paginate newest first without duplicates", async () => {
        const publicId = await uploadPng("alice", pngPath);
        const ids: string[] = [];
        for (let index = 0; index < 3; index += 1) {
          const created = await gql(
            "alice",
            "mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { id } }",
            { input: { caption: String(index), media: [{ publicId, type: "IMAGE" }] } }
          );
          expectOk(created);
          ids.push(String(field(created, "createPost", "id")));
        }

        let cursor: string | null = null;
        const pageIds: string[] = [];
        do {
          const page = await gql(
            "bob",
            "query Page($after: String) { userPosts(username: \"alice\", first: 1, after: $after) { items { id } nextCursor } }",
            { after: cursor }
          );
          expectOk(page);
          const result = page.data?.userPosts;
          if (!isRecord(result) || !Array.isArray(result.items)) throw new Error("Post page was invalid.");
          for (const item of result.items) {
            if (!isRecord(item) || typeof item.id !== "string") throw new Error("Post item was invalid.");
            pageIds.push(item.id);
          }
          cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
        } while (cursor);

        assertEqual(pageIds.length, 3, "paginated post count");
        assertEqual(new Set(pageIds).size, 3, "no duplicate post ids");
        assertEqual(pageIds[0], ids[2], "newest post is first");
      }))
    ) {
      return;
    }
  } finally {
    await unlink(pngPath).catch(() => undefined);
  }
}
