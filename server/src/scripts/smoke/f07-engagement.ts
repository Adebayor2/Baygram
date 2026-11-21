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

async function uploadPostImage(userName: string, pngPath: string): Promise<string> {
  const signed = await gql(
    userName,
    "mutation { createUploadSignature(kind: POST_IMAGE) { apiKey timestamp folder signature resourceType uploadUrl } }"
  );
  expectOk(signed);
  const value = signed.data?.createUploadSignature;
  if (!isRecord(value)) throw new Error("Upload signature was not returned.");
  const signature = {
    cloudName: "",
    apiKey: String(value.apiKey),
    timestamp: Number(value.timestamp),
    folder: String(value.folder),
    signature: String(value.signature),
    resourceType: String(value.resourceType),
    uploadUrl: String(value.uploadUrl),
  };
  return (await uploadToCloudinary(signature, pngPath)).publicId;
}

async function createPost(userName: string, publicId: string): Promise<string> {
  const response = await gql(
    userName,
    "mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { id } }",
    { input: { caption: "F7 post", media: [{ publicId, type: "IMAGE" }] } }
  );
  expectOk(response);
  const id = field(response, "createPost", "id");
  if (typeof id !== "string") throw new Error("Post id was not returned.");
  return id;
}

export async function run(): Promise<void> {
  await resetData();
  await ensureProfiles();

  const pngPath = join(tmpdir(), `baygram-f07-${process.pid}.png`);
  await writeFile(
    pngPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );

  try {
    await gql("alice", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');
    await gql("bob", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');
    await gql("carol", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');

    const publicId = await uploadPostImage("alice", pngPath);
    const postId = await createPost("alice", publicId);

    if (!(await step("likes are visible and idempotent", async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const liked = await gql(
          "bob",
          "mutation Like($postId: ID!) { likePost(postId: $postId) { likesCount viewerHasLiked } }",
          { postId }
        );
        expectOk(liked);
        assertEqual(field(liked, "likePost", "likesCount"), 1, "likesCount");
        assertEqual(field(liked, "likePost", "viewerHasLiked"), true, "Bob viewerHasLiked");
      }
      const aliceView = await gql(
        "alice",
        "query Post($postId: ID!) { post(id: $postId) { viewerHasLiked likesCount } }",
        { postId }
      );
      expectOk(aliceView);
      assertEqual(field(aliceView, "post", "viewerHasLiked"), false, "Alice viewerHasLiked");

      const unliked = await gql(
        "bob",
        "mutation Unlike($postId: ID!) { unlikePost(postId: $postId) { likesCount } }",
        { postId }
      );
      expectOk(unliked);
      assertEqual(field(unliked, "unlikePost", "likesCount"), 0, "likesCount after unlike");
    }))) return;

    let topCommentId = "";
    let replyId = "";
    if (!(await step("comments and one-level replies update counters", async () => {
      const comment = await gql(
        "carol",
        "mutation Comment($postId: ID!) { addComment(postId: $postId, body: \"Top comment\") { id repliesCount } }",
        { postId }
      );
      expectOk(comment);
      topCommentId = String(field(comment, "addComment", "id"));

      const reply = await gql(
        "bob",
        "mutation Reply($postId: ID!, $parentId: ID!) { addComment(postId: $postId, body: \"Reply\", parentId: $parentId) { id } }",
        { postId, parentId: topCommentId }
      );
      expectOk(reply);
      replyId = String(field(reply, "addComment", "id"));

      const invalidReply = await gql(
        "bob",
        "mutation Reply($postId: ID!, $parentId: ID!) { addComment(postId: $postId, body: \"Nested\", parentId: $parentId) { id } }",
        { postId, parentId: replyId }
      );
      expectError(invalidReply, "BAD_USER_INPUT");

      const post = await gql(
        "alice",
        "query Post($postId: ID!) { post(id: $postId) { commentsCount comments { items { id repliesCount } } } }",
        { postId }
      );
      expectOk(post);
      assertEqual(field(post, "post", "commentsCount"), 2, "commentsCount");
    }))) return;

    if (!(await step("deleteComment respects ownership and cascades replies", async () => {
      const bobDelete = await gql(
        "bob",
        "mutation Delete($commentId: ID!) { deleteComment(commentId: $commentId) }",
        { commentId: topCommentId }
      );
      expectError(bobDelete, "FORBIDDEN");

      const ownerDelete = await gql(
        "alice",
        "mutation Delete($commentId: ID!) { deleteComment(commentId: $commentId) }",
        { commentId: topCommentId }
      );
      expectOk(ownerDelete);
      assertEqual(ownerDelete.data?.deleteComment, true, "top-level comment deleted");

      const post = await gql(
        "alice",
        "query Post($postId: ID!) { post(id: $postId) { commentsCount } }",
        { postId }
      );
      expectOk(post);
      assertEqual(field(post, "post", "commentsCount"), 0, "commentsCount after delete");
    }))) return;

    if (!(await step("saved posts and likers pagination work", async () => {
      const saved = await gql(
        "bob",
        "mutation Save($postId: ID!) { savePost(postId: $postId) { id } }",
        { postId }
      );
      expectOk(saved);
      const savedList = await gql("bob", "{ savedPosts { items { id } nextCursor } }");
      expectOk(savedList);
      const ids = savedList.data?.savedPosts;
      if (!isRecord(ids) || !Array.isArray(ids.items)) throw new Error("savedPosts was invalid.");
      assertEqual(ids.items.length > 0, true, "savedPosts contains post");

      await gql("bob", "mutation Unsave($postId: ID!) { unsavePost(postId: $postId) { id } }", { postId });
      await gql("bob", "mutation Like($postId: ID!) { likePost(postId: $postId) { id } }", { postId });
      await gql("carol", "mutation Like($postId: ID!) { likePost(postId: $postId) { id } }", { postId });
      const likers = await gql(
        "alice",
        "query Likers($postId: ID!) { likers(postId: $postId, first: 1) { items { username } nextCursor } }",
        { postId }
      );
      expectOk(likers);
      const page = likers.data?.likers;
      if (!isRecord(page) || !Array.isArray(page.items)) throw new Error("likers was invalid.");
      assertEqual(page.items.length, 1, "likers page size");
    }))) return;

    if (!(await step("private and blocked accounts cannot engage", async () => {
      await gql("alice", 'mutation { updateProfile(input: { isPrivate: true }) { id } }');
      const privatePost = await createPost("alice", publicId);
      const bobLike = await gql(
        "bob",
        "mutation Like($postId: ID!) { likePost(postId: $postId) { id } }",
        { postId: privatePost }
      );
      expectError(bobLike, "NOT_FOUND");
      const bobComment = await gql(
        "bob",
        "mutation Comment($postId: ID!) { addComment(postId: $postId, body: \"No\") { id } }",
        { postId: privatePost }
      );
      expectError(bobComment, "NOT_FOUND");

      await gql("alice", 'mutation { block(username: "bob") { id } }');
      const blockedLike = await gql(
        "bob",
        "mutation Like($postId: ID!) { likePost(postId: $postId) { id } }",
        { postId: privatePost }
      );
      expectError(blockedLike, "NOT_FOUND");
    }))) return;
  } finally {
    await unlink(pngPath).catch(() => undefined);
  }
}
