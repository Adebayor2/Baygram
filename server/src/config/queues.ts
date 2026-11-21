import { Redis } from "ioredis";
import { Queue } from "bullmq";
import { env } from "./env.js";

export const bullRedis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: null,
});

export const defaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export const notificationQueue = new Queue("notifications", {
  connection: bullRedis,
  defaultJobOptions,
});

export const mediaQueue = new Queue("media", {
  connection: bullRedis,
  defaultJobOptions,
});

export const maintenanceQueue = new Queue("maintenance", {
  connection: bullRedis,
  defaultJobOptions,
});
