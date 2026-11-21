import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { uploadToCloudinary } from "../upload.js";
import { extractHashtags, extractMentions } from "../../lib/hashtags.js";
import {
  assertEqual,
  ensureProfiles,
  expectOk,
  gql,
  redis,
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

async function createPost(
  userName: string,
  publicId: string,
  caption: string
): Promise<string> {
  const response = await gql(
    userName,
    "mutation Create($input: CreatePostInput!) { createPost(input: $input) { id } }",
    { input: { caption, media: [{ publicId, type: "IMAGE" }] } }
  );
  expectOk(response);
  const id = field(response, "createPost", "id");
  if (typeof id !== "string") throw new Error("Post id was not returned.");
  return id;
}

export async function run(): Promise<void> {
  await resetData();
  await ensureProfiles();

  await gql("alice", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');
  await gql("bob", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');
  await gql("carol", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');

  const pngPath = join(tmpdir(), `baygram-f09-${process.pid}.png`);
  await writeFile(
    pngPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );

  let postId = "";
  try {
    const publicId = await uploadPostImage("alice", pngPath);
    postId = await createPost(
      "alice",
      publicId,
      "Hello #Lagos #lagos #food @bob"
    );

    if (!(await step("captions sync hashtags and mentions", async () => {
      const post = await gql(
        "alice",
        "query Post($id: ID!) { post(id: $id) { hashtags mentions { username } } }",
        { id: postId }
      );
      expectOk(post);
      const tags = field(post, "post", "hashtags");
      const mentions = field(post, "post", "mentions");
      assertEqual(Array.isArray(tags) && tags.join(","), "lagos,food", "unique hashtags");
      assertEqual(Array.isArray(mentions) && mentions[0] && isRecord(mentions[0]) ? mentions[0].username : null, "bob", "bob mention");

      const lagos = await gql("alice", '{ hashtag(name: "lagos") { name postsCount } }');
      expectOk(lagos);
      assertEqual(field(lagos, "hashtag", "postsCount"), 1, "lagos postsCount");
    }))) return;

    if (!(await step("editing and deleting update hashtag counts", async () => {
      await gql(
        "alice",
        "mutation Edit($id: ID!) { updatePostCaption(postId: $id, caption: \"Hello #lagos @bob\") { id } }",
        { id: postId }
      );
      const food = await gql("alice", '{ hashtag(name: "food") { postsCount } }');
      expectOk(food);
      assertEqual(field(food, "hashtag", "postsCount"), 0, "food postsCount");

      await gql(
        "alice",
        "mutation Delete($id: ID!) { deletePost(postId: $id) }",
        { id: postId }
      );
      const lagos = await gql("alice", '{ hashtag(name: "lagos") { postsCount } }');
      expectOk(lagos);
      assertEqual(field(lagos, "hashtag", "postsCount"), 0, "lagos postsCount after delete");
    }))) return;

    if (!(await step("search users and hashtags work and cache Redis keys", async () => {
      const users = await gql("alice", '{ searchUsers(query: "al", first: 20) { items { username } nextCursor } }');
      expectOk(users);
      const page = users.data?.searchUsers;
      if (!isRecord(page) || !Array.isArray(page.items)) throw new Error("searchUsers invalid.");
      assertEqual(page.items.some((item) => isRecord(item) && item.username === "alice"), true, "alice found");

      const shortQuery = await gql("alice", '{ searchUsers(query: "a", first: 20) { items { username } } }');
      expectOk(shortQuery);
      const shortPage = shortQuery.data?.searchUsers;
      assertEqual(isRecord(shortPage) && Array.isArray(shortPage.items) ? shortPage.items.length : -1, 0, "one-character search");

      await gql("bob", 'mutation { block(username: "alice") { id } }');
      const blockedSearch = await gql("bob", '{ searchUsers(query: "al", first: 20) { items { username } } }');
      expectOk(blockedSearch);
      const blockedPage = blockedSearch.data?.searchUsers;
      assertEqual(
        isRecord(blockedPage) && Array.isArray(blockedPage.items)
          ? blockedPage.items.some((item) => isRecord(item) && item.username === "alice")
          : true,
        false,
        "blocked alice excluded"
      );

      await gql("alice", 'mutation { unblock(username: "bob") { id } }');
      const tags = await gql("alice", '{ searchHashtags(query: "la", first: 10) { name postsCount } }');
      expectOk(tags);
      const tagItems = tags.data?.searchHashtags;
      assertEqual(Array.isArray(tagItems) && tagItems.some((item) => isRecord(item) && item.name === "lagos"), true, "lagos found");

      await gql("alice", '{ searchUsers(query: "bo", first: 20) { items { username } } }');
      await gql("alice", '{ searchHashtags(query: "la", first: 10) { name } }');
      const userKey = await redis.exists("cache:search:users:bo");
      const tagKey = await redis.exists("cache:search:tags:la");
      assertEqual(userKey, 1, "search user cache exists");
      assertEqual(tagKey, 1, "search tag cache exists");
      assertEqual((await redis.ttl("cache:search:users:bo")) <= 30, true, "search user TTL");
      assertEqual((await redis.ttl("cache:search:tags:la")) <= 30, true, "search tag TTL");
    }))) return;

    if (!(await step("inline extraction handles tricky input", async () => {
      assertEqual(
        extractHashtags("a#b # #lagos #lagos #café").join(","),
        "lagos,café",
        "extractHashtags"
      );
      assertEqual(
        extractMentions("x @bob @bob @al").join(","),
        "bob",
        "extractMentions"
      );
    }))) return;
  } finally {
    await unlink(pngPath).catch(() => undefined);
  }
}
