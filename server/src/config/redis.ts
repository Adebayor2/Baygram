import { Redis } from "ioredis";
import { env } from "./env.js";

export const redis = new Redis(env.redisUrl);

redis.on("connect", () => console.log("Redis connected"));
redis.on("error", (err: Error) => console.error("Redis error:", err.message));