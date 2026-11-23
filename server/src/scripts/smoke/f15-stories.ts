import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../../config/db.js";
import { mediaQueue } from "../../config/queues.js";
import { uploadToCloudinary } from "../upload.js";
import {
  assertEqual,
  ensureProfiles,
  expectOk,
  gql,
  poll,
  resetData,
  step,
} from "./helpers.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function run(): Promise<void> {
  await resetData();
  await ensureProfiles();

  await gql("alice", "mutation { updateProfile(input: { isPrivate: false }) { id } }");
  await gql("bob", "mutation { updateProfile(input: { isPrivate: false }) { id } }");
  await gql("carol", "mutation { updateProfile(input: { isPrivate: true }) { id } }");
  const follow = await gql("alice", "mutation { follow(username: \"bob\") { id viewerFollowStatus } }");
  expectOk(follow);

  const pngPath = join(tmpdir(), `baygram-f15-${process.pid}.png`);
  await writeFile(
    pngPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );

  let publicId = "";
  let storyId = "";
  try {
    const signed = await gql(
      "bob",
      "mutation { createUploadSignature(kind: STORY_IMAGE) { apiKey timestamp folder signature resourceType uploadUrl } }"
    );
    expectOk(signed);
    const signature = signed.data?.createUploadSignature;
    if (!isRecord(signature)) throw new Error("Story upload signature was not returned.");
    const uploaded = await uploadToCloudinary(
      {
        cloudName: String(signature.cloudName),
        apiKey: String(signature.apiKey),
        timestamp: Number(signature.timestamp),
        folder: String(signature.folder),
        signature: String(signature.signature),
        resourceType: String(signature.resourceType),
        uploadUrl: String(signature.uploadUrl),
      },
      pngPath
    );
    publicId = uploaded.publicId;

    const created = await gql(
      "bob",
      "mutation Create($media: MediaInput!) { createStory(media: $media, caption: \"F15\") { id viewersCount media { publicId } } }",
      { media: { publicId, type: "IMAGE" } }
    );
    expectOk(created);
    const story = created.data?.createStory;
    if (!isRecord(story) || typeof story.id !== "string") {
      throw new Error("Story id was not returned.");
    }
    storyId = story.id;

    await step("alice sees bob's unseen story in the tray", async () => {
      const tray = await gql(
        "alice",
        "{ storiesTray { author { username } stories { id viewedByViewer } hasUnseen latestAt } }"
      );
      expectOk(tray);
      const groups = tray.data?.storiesTray;
      assertEqual(Array.isArray(groups), true, "stories tray is an array");
      if (Array.isArray(groups)) {
        const bobGroup = groups.find(
          (group) =>
            isRecord(group) &&
            isRecord(group.author) &&
            group.author.username === "bob"
        );
        assertEqual(isRecord(bobGroup), true, "bob appears in alice's tray");
        if (isRecord(bobGroup) && Array.isArray(bobGroup.stories)) {
          const item = bobGroup.stories.find(
            (item) => isRecord(item) && item.id === storyId
          );
          assertEqual(isRecord(item), true, "bob's story is listed");
          assertEqual(bobGroup.hasUnseen, true, "story group is unseen");
        }
      }
    });

    await step("viewing is idempotent and author views do not count", async () => {
      const first = await gql("alice", "mutation View($id: ID!) { viewStory(storyId: $id) }", { id: storyId });
      expectOk(first);
      const second = await gql("alice", "mutation View($id: ID!) { viewStory(storyId: $id) }", { id: storyId });
      expectOk(second);
      const authorView = await gql("bob", "mutation View($id: ID!) { viewStory(storyId: $id) }", { id: storyId });
      expectOk(authorView);
      const storyPage = await prisma.story.findUnique({ where: { id: storyId } });
      assertEqual(storyPage?.viewersCount, 1, "only alice's view is counted");
      const tray = await gql("alice", "{ storiesTray { stories { id viewedByViewer } } }");
      expectOk(tray);
    });

    await step("story viewers are author-only", async () => {
      const bobViewers = await gql(
        "bob",
        "query Viewers($id: ID!) { storyViewers(storyId: $id) { items { username } } }",
        { id: storyId }
      );
      expectOk(bobViewers);
      assertEqual(
        bobViewers.data?.storyViewers &&
          isRecord(bobViewers.data.storyViewers) &&
          Array.isArray(bobViewers.data.storyViewers.items),
        true,
        "author can list viewers"
      );
      const aliceViewers = await gql(
        "alice",
        "query Viewers($id: ID!) { storyViewers(storyId: $id) { items { username } } }",
        { id: storyId }
      );
      assertEqual(
        aliceViewers.errors?.[0]?.extensions?.code,
        "FORBIDDEN",
        "non-author is forbidden"
      );
    });

    await step("private stories require accepted follow", async () => {
      const privateStories = await gql(
        "bob",
        "query { userStories(username: \"carol\") { id } }"
      );
      assertEqual(
        privateStories.errors?.[0]?.extensions?.code,
        "FORBIDDEN",
        "bob cannot see carol's private stories"
      );
    });

    await step("expired stories are removed by cleanup", async () => {
      await prisma.story.update({
        where: { id: storyId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expiredTray = await gql("alice", "{ storiesTray { stories { id } } }");
      expectOk(expiredTray);
      await maintenanceCleanup();
      await poll("expired story cleanup", async () =>
        (await prisma.story.findUnique({ where: { id: storyId } })) === null
      );
      await poll("expired story media queued", async () =>
        (await mediaQueue.getJobs(["waiting", "delayed", "completed", "failed"])).some(
          (job) => isRecord(job.data) && job.data.publicId === publicId
        )
      );
    });
  } finally {
    await unlink(pngPath).catch(() => undefined);
  }
}

async function maintenanceCleanup(): Promise<void> {
  const { cleanupExpiredStories } =
    await import("../../modules/stories/service.js");
  await cleanupExpiredStories();
}
