import { Worker } from "bullmq";
import { bullRedis } from "./config/queues.js";
import { processNotificationJob } from "./modules/notifications/service.js";
import { processMediaDestroy } from "./jobs/processors/media.js";
import { refreshExplore } from "./jobs/processors/explore.js";
import { maintenanceQueue } from "./config/queues.js";
import { cleanupExpiredStories } from "./modules/stories/service.js";
import { configurePush, sendToUser } from "./modules/push/service.js";
import {
  processCallDisconnect,
  processCallRingTimeout,
} from "./modules/calls/service.js";

const notificationWorker = new Worker(
  "notifications",
  async (job) => {
    if (job.name === "notifications:create") {
      await processNotificationJob(job.data);
    }
  },
  { connection: bullRedis }
);
notificationWorker.on("completed", (job) =>
  console.log(`Job completed notifications:${job.id}`)
);
notificationWorker.on("failed", (job, error) =>
  console.error(`Job failed notifications:${job?.id}`, error.message)
);

const mediaWorker = new Worker(
  "media",
  async (job) => {
    if (job.name === "media:destroy") {
      await processMediaDestroy(job.data);
    }
  },
  { connection: bullRedis }
);

const maintenanceWorker = new Worker(
  "maintenance",
  async (job) => {
    if (job.name === "explore:refresh") {
      await refreshExplore();
    }
    if (job.name === "stories:cleanup") {
      await cleanupExpiredStories();
    }
  },
  { connection: bullRedis }
);

configurePush();
const pushWorker = new Worker(
  "push",
  async (job) => {
    if (job.name === "push:send") {
      await sendToUser(job.data.userId, job.data.payload);
    }
  },
  { connection: bullRedis }
);

const callsWorker = new Worker(
  "calls",
  async (job) => {
    if (job.name === "call:ring") {
      await processCallRingTimeout(job.data.callId);
    }
    if (job.name === "call:disconnect") {
      await processCallDisconnect(job.data.callId, job.data.userId);
    }
  },
  { connection: bullRedis }
);

await maintenanceQueue.upsertJobScheduler(
  "explore-refresh",
  { every: 5 * 60 * 1000 },
  { name: "explore:refresh", data: {} }
);
await maintenanceQueue.upsertJobScheduler(
  "stories-cleanup",
  { every: 60 * 60 * 1000 },
  { name: "stories:cleanup", data: {} }
);

async function shutdown(): Promise<void> {
  await Promise.all([
    notificationWorker.close(),
    mediaWorker.close(),
    maintenanceWorker.close(),
    pushWorker.close(),
    callsWorker.close(),
  ]);
  await bullRedis.quit();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

console.log("Workers ready");
