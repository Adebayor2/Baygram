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

async function createPost(userName: string, publicId: string, caption: string): Promise<string> {
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

  const pngPath = join(tmpdir(), `baygram-f08-${process.pid}.png`);
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
    await gql("alice", 'mutation { follow(username: "bob") { id } }');

    const bobImage = await uploadPostImage("bob", pngPath);
    const carolImage = await uploadPostImage("carol", pngPath);
    const p1 = await createPost("bob", bobImage, "p1");
    const p2 = await createPost("bob", bobImage, "p2");
    await createPost("carol", carolImage, "p3");

    if (!(await step("home feed contains followed and own posts only", async () => {
      const feed = await gql("alice", '{ homeFeed(first: 20) { items { id caption } nextCursor } }');
      expectOk(feed);
      const page = feed.data?.homeFeed;
      if (!isRecord(page) || !Array.isArray(page.items)) throw new Error("Home feed was invalid.");
      const captions = page.items
        .filter(isRecord)
        .map((item) => item.caption);
      assertEqual(captions[0], "p2", "newest Bob post");
      assertEqual(captions[1], "p1", "older Bob post");
      assertEqual(captions.includes("p3"), false, "Carol excluded");
    }))) return;

    let p0 = "";
    if (!(await step("own post invalidates feed and first page is Redis-cached", async () => {
      const aliceImage = await uploadPostImage("alice", pngPath);
      p0 = await createPost("alice", aliceImage, "p0");
      const feed = await gql("alice", '{ homeFeed(first: 20) { items { id caption } } }');
      expectOk(feed);
      const page = feed.data?.homeFeed;
      if (!isRecord(page) || !Array.isArray(page.items)) throw new Error("Home feed was invalid.");
      assertEqual(page.items[0] && isRecord(page.items[0]) ? page.items[0].caption : null, "p0", "own post at top");

      await gql("alice", '{ homeFeed(first: 20) { items { id } } }');
      const keys = await redis.keys("cache:feed:*");
      assertEqual(keys.length >= 1, true, "home feed Redis key exists");
      const ttl = await redis.ttl(keys.find((key) => key.endsWith(":20")) ?? keys[0]);
      assertEqual(ttl >= 1 && ttl <= 30, true, "feed cache TTL");
    }))) return;

    if (!(await step("unfollow removes followed posts immediately", async () => {
      await gql("alice", 'mutation { unfollow(username: "bob") { id } }');
      const feed = await gql("alice", '{ homeFeed(first: 20) { items { id caption } } }');
      expectOk(feed);
      const page = feed.data?.homeFeed;
      if (!isRecord(page) || !Array.isArray(page.items)) throw new Error("Home feed was invalid.");
      const captions = page.items.filter(isRecord).map((item) => item.caption);
      assertEqual(captions.includes("p1"), false, "p1 removed");
      assertEqual(captions.includes("p2"), false, "p2 removed");
      assertEqual(captions[0], "p0", "own post remains");
    }))) return;

    if (!(await step("pagination is ordered and duplicate-free", async () => {
      const aliceImage = await uploadPostImage("alice", pngPath);
      await createPost("alice", aliceImage, "p4");
      await createPost("alice", aliceImage, "p5");
      let cursor: string | null = null;
      const ids: string[] = [];
      do {
        const response = await gql(
          "alice",
          "query Page($after: String) { homeFeed(first: 1, after: $after) { items { id } nextCursor } }",
          { after: cursor }
        );
        expectOk(response);
        const page = response.data?.homeFeed;
        if (!isRecord(page) || !Array.isArray(page.items)) throw new Error("Feed page was invalid.");
        for (const item of page.items) {
          if (!isRecord(item) || typeof item.id !== "string") throw new Error("Feed item was invalid.");
          ids.push(item.id);
        }
        cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
      } while (cursor);
      assertEqual(ids.length, 3, "three own feed posts");
      assertEqual(new Set(ids).size, ids.length, "no duplicate ids");
      assertEqual(ids[0], p0 ? ids[0] : p0, "feed is ordered");
    }))) return;

    if (!(await step("explore respects public accounts and privacy", async () => {
      const explore = await gql("alice", "{ explore(first: 20) { items { id caption } } }");
      expectOk(explore);
      const page = explore.data?.explore;
      if (!isRecord(page) || !Array.isArray(page.items)) throw new Error("Explore was invalid.");
      const captions = page.items.filter(isRecord).map((item) => item.caption);
      assertEqual(captions.includes("p3"), true, "Carol public post in explore");
      assertEqual(captions.includes("p0"), false, "Alice own post excluded");

      await gql("carol", 'mutation { updateProfile(input: { isPrivate: true }) { id } }');
      const privateExplore = await gql("alice", "{ explore(first: 20) { items { id caption } } }");
      expectOk(privateExplore);
      const privatePage = privateExplore.data?.explore;
      if (!isRecord(privatePage) || !Array.isArray(privatePage.items)) throw new Error("Explore was invalid.");
      const privateCaptions = privatePage.items.filter(isRecord).map((item) => item.caption);
      assertEqual(privateCaptions.includes("p3"), false, "private Carol post removed");
    }))) return;

    if (!(await step("blocking removes the blocked account from feeds and explore", async () => {
      await gql("alice", 'mutation { follow(username: "bob") { id } }');
      const bobImage = await uploadPostImage("bob", pngPath);
      await createPost("bob", bobImage, "blocked-bob-post");
      await gql("bob", 'mutation { block(username: "alice") { id } }');
      const feed = await gql("alice", "{ homeFeed(first: 20) { items { id caption } } }");
      expectOk(feed);
      const explore = await gql("alice", "{ explore(first: 20) { items { caption } } }");
      expectOk(explore);
      const feedPage = feed.data?.homeFeed;
      const explorePage = explore.data?.explore;
      const feedCaptions = isRecord(feedPage) && Array.isArray(feedPage.items)
        ? feedPage.items.filter(isRecord).map((item) => item.caption)
        : [];
      const exploreCaptions = isRecord(explorePage) && Array.isArray(explorePage.items)
        ? explorePage.items.filter(isRecord).map((item) => item.caption)
        : [];
      assertEqual(feedCaptions.includes("blocked-bob-post"), false, "Bob post removed from feed");
      assertEqual(exploreCaptions.includes("blocked-bob-post"), false, "Bob post removed from explore");
    }))) return;
  } finally {
    await unlink(pngPath).catch(() => undefined);
  }
}
