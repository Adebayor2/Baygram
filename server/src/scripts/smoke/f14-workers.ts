import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Queue, Worker } from "bullmq";
import { cloudinary } from "../../config/cloudinary.js";
import {
  bullRedis,
  defaultJobOptions,
  maintenanceQueue,
  notificationQueue,
} from "../../config/queues.js";
import { prisma } from "../../config/db.js";
import { redis } from "../../config/redis.js";
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

function isCloudinaryNotFound(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const nested = isRecord(error.error) ? error.error : null;
  return [error.http_code, error.statusCode, error.status, nested?.http_code]
    .some((status) => Number(status) === 404);
}

async function cloudinaryAssetIsMissing(publicId: string): Promise<boolean> {
  try {
    await cloudinary.api.resource(publicId, { resource_type: "image" });
    return false;
  } catch (error) {
    if (isCloudinaryNotFound(error)) return true;
    const message =
      error instanceof Error
        ? error.message
        : isRecord(error) && typeof error.message === "string"
          ? error.message
          : "unrecognized Cloudinary error";
    throw new Error(`Cloudinary resource lookup failed: ${message}`);
  }
}

export async function run(): Promise<void> {
  await resetData();
  await ensureProfiles();

  const alice = await gql("alice", "{ me { id } }");
  const bob = await gql("bob", "{ me { id } }");
  expectOk(alice);
  expectOk(bob);
  const aliceId = alice.data?.me && isRecord(alice.data.me) ? alice.data.me.id : null;
  const bobId = bob.data?.me && isRecord(bob.data.me) ? bob.data.me.id : null;
  if (typeof aliceId !== "string" || typeof bobId !== "string") {
    throw new Error("Test user ids were not returned.");
  }

  const aliceProfile = await gql(
    "alice",
    "mutation { updateProfile(input: { isPrivate: false }) { id } }"
  );
  const bobProfile = await gql(
    "bob",
    "mutation { updateProfile(input: { isPrivate: false }) { id } }"
  );
  expectOk(aliceProfile);
  expectOk(bobProfile);

  const alicePost = await prisma.post.create({
    data: {
      authorId: aliceId,
      caption: "F14 Alice post",
      likesCount: 4,
      commentsCount: 2,
    },
  });
  const bobPost = await prisma.post.create({
    data: {
      authorId: bobId,
      caption: "F14 Bob post",
      likesCount: 1,
      commentsCount: 0,
    },
  });

  if (
    !(await step("worker processes queued likes into notifications", async () => {
      const liked = await gql(
        "bob",
        "mutation Like($postId: ID!) { likePost(postId: $postId) { id } }",
        { postId: alicePost.id }
      );
      expectOk(liked);
      await poll("Alice notification", async () => {
        const page = await gql(
          "alice",
          "{ notifications(unreadOnly: true) { items { type } } }"
        );
        expectOk(page);
        const data = page.data?.notifications;
        return (
          isRecord(data) &&
          Array.isArray(data.items) &&
          data.items.some((item) => isRecord(item) && item.type === "LIKE")
        );
      });
    }))
  ) {
    return;
  }

  if (
    !(await step("queued likes survive a worker pause and resume", async () => {
      await notificationQueue.pause();
      try {
        const liked = await gql(
          "alice",
          "mutation Like($postId: ID!) { likePost(postId: $postId) { id } }",
          { postId: bobPost.id }
        );
        expectOk(liked);
        await poll("waiting like job", async () => {
          const jobs = await notificationQueue.getJobs(["waiting"]);
          return jobs.some((job) => job.data.postId === bobPost.id);
        });
        const beforeResume = await prisma.notification.findFirst({
          where: { recipientId: bobId, postId: bobPost.id, type: "LIKE" },
        });
        assertEqual(beforeResume, null, "notification stays queued while paused");
      } finally {
        await notificationQueue.resume();
      }

      await poll("resumed worker notification", async () => {
        const page = await gql(
          "bob",
          "{ notifications { items { type post { id } } } }"
        );
        expectOk(page);
        const result = page.data?.notifications;
        return (
          isRecord(result) &&
          Array.isArray(result.items) &&
          result.items.some(
            (item) =>
              isRecord(item) &&
              item.type === "LIKE" &&
              isRecord(item.post) &&
              item.post.id === bobPost.id
          )
        );
      });
    }))
  ) {
    return;
  }

  if (
    !(await step("notification jobs are retained in BullMQ", async () => {
      const counts = await notificationQueue.getJobCounts("completed");
      assertEqual(counts.completed > 0, true, "completed notification job retained");
    }))
  ) {
    return;
  }

  if (
    !(await step("explore refresh writes ranked posts with stable pagination", async () => {
      await maintenanceQueue.add("explore:refresh", {});
      await poll("explore refresh", async () => {
        const ids = await redis.zrevrange("explore:trending", 0, 1);
        return ids[0] === alicePost.id && ids[1] === bobPost.id;
      });
      const rankedIds = await redis.zrevrange("explore:trending", 0, 1);
      assertEqual(rankedIds[0], alicePost.id, "higher-engagement post ranks first");
      assertEqual(rankedIds[1], bobPost.id, "lower-engagement post ranks second");

      const explore = await gql(
        "alice",
        "{ explore(first: 50) { items { id } nextCursor } }"
      );
      expectOk(explore);
      const page = explore.data?.explore;
      assertEqual(
        isRecord(page) &&
          Array.isArray(page.items) &&
          page.items.some((item) => isRecord(item) && item.id === bobPost.id),
        true,
        "Explore filters own posts and returns other ranked posts"
      );

      let cursor: string | null = null;
      const ids: string[] = [];
      do {
        const response = await gql(
          "alice",
          "query Page($after: String) { explore(first: 1, after: $after) { items { id } nextCursor } }",
          { after: cursor }
        );
        expectOk(response);
        const data = response.data?.explore;
        if (!isRecord(data) || !Array.isArray(data.items)) {
          throw new Error("Explore page invalid.");
        }
        for (const item of data.items) {
          if (isRecord(item) && typeof item.id === "string") ids.push(item.id);
        }
        cursor = typeof data.nextCursor === "string" ? data.nextCursor : null;
      } while (cursor);
      assertEqual(new Set(ids).size, ids.length, "ranked pagination has no duplicates");
    }))
  ) {
    return;
  }

  if (
    !(await step("failed jobs retry after a transient processor error", async () => {
      const queueName = `f14-retry-${process.pid}`;
      const queue = new Queue(queueName, {
        connection: bullRedis,
        defaultJobOptions: {
          ...defaultJobOptions,
          backoff: { type: "exponential", delay: 50 },
          removeOnComplete: false,
        },
      });
      let attempts = 0;
      const worker = new Worker(
        queueName,
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("Intentional one-time retry test failure.");
          }
        },
        { connection: bullRedis }
      );
      try {
        await worker.waitUntilReady();
        const job = await queue.add("retry-once", {});
        const jobId = job.id;
        if (typeof jobId !== "string") {
          throw new Error("Retry test job id was not assigned.");
        }
        await poll("retry test completion", async () => {
          const current = await queue.getJob(jobId);
          return (
            current !== undefined &&
            (await current.getState()) === "completed"
          );
        });
        const completed = await queue.getJob(jobId);
        assertEqual(attempts, 2, "processor runs again after one failure");
        assertEqual(completed?.attemptsMade, 2, "both processor attempts are recorded");
      } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    }))
  ) {
    return;
  }

  if (
    !(await step("deleting a post queues Cloudinary asset deletion", async () => {
      const pngPath = join(tmpdir(), `baygram-f14-${process.pid}.png`);
      await writeFile(
        pngPath,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64"
        )
      );
      let publicId: string | null = null;
      try {
        const signed = await gql(
          "alice",
          "mutation { createUploadSignature(kind: POST_IMAGE) { apiKey timestamp folder signature resourceType uploadUrl } }"
        );
        expectOk(signed);
        const value = signed.data?.createUploadSignature;
        if (!isRecord(value)) {
          throw new Error("Upload signature was not returned.");
        }
        const uploaded = await uploadToCloudinary(
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
        );
        const uploadedPublicId = uploaded.publicId;
        publicId = uploadedPublicId;
        const created = await gql(
          "alice",
          "mutation Create($input: CreatePostInput!) { createPost(input: $input) { id } }",
          {
            input: {
              caption: "F14 queued media deletion",
              media: [{ publicId: uploadedPublicId, type: "IMAGE" }],
            },
          }
        );
        expectOk(created);
        const createdPost = created.data?.createPost;
        if (!isRecord(createdPost) || typeof createdPost.id !== "string") {
          throw new Error("Post id was not returned.");
        }

        const deleted = await gql(
          "alice",
          "mutation Delete($postId: ID!) { deletePost(postId: $postId) }",
          { postId: createdPost.id }
        );
        expectOk(deleted);
        assertEqual(deleted.data?.deletePost, true, "post deletion");
        await poll(
          "Cloudinary asset deletion",
          () => cloudinaryAssetIsMissing(uploadedPublicId),
          30_000
        );
      } finally {
        await unlink(pngPath).catch(() => undefined);
        if (publicId && !(await cloudinaryAssetIsMissing(publicId))) {
          await cloudinary.uploader.destroy(publicId);
        }
      }
    }))
  ) {
    return;
  }

  await prisma.post.deleteMany({
    where: { id: { in: [alicePost.id, bobPost.id] } },
  });
}
