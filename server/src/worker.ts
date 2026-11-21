import { Worker } from "bullmq";
import { bullRedis } from "./config/queues.js";
import { processNotificationJob } from "./modules/notifications/service.js";
import { processMediaDestroy } from "./jobs/processors/media.js";
import { refreshExplore } from "./jobs/processors/explore.js";
import { maintenanceQueue } from "./config/queues.js";

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
  },
  { connection: bullRedis }
);

await maintenanceQueue.upsertJobScheduler(
  "explore-refresh",
  { every: 5 * 60 * 1000 },
  { name: "explore:refresh", data: {} }
);

async function shutdown(): Promise<void> {
  await Promise.all([
    notificationWorker.close(),
    mediaWorker.close(),
    maintenanceWorker.close(),
  ]);
  await bullRedis.quit();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

console.log("Workers ready");
