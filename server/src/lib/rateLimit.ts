import { GraphQLError } from "graphql";
import { redis } from "../config/redis.js";

export interface RateLimitInput {
  scope: string;
  id: string;
  limit: number;
  windowSec: number;
}

export interface RateLimitStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
}

export function rateLimitKey(
  input: RateLimitInput,
  nowMs = Date.now()
): string {
  const nowSec = Math.floor(nowMs / 1000);
  const windowStart = Math.floor(nowSec / input.windowSec) * input.windowSec;
  return `rl:${input.scope}:${input.id}:${windowStart}`;
}

export async function rateLimit(
  input: RateLimitInput,
  store: RateLimitStore = redis,
  nowMs = Date.now()
): Promise<void> {
  const key = rateLimitKey(input, nowMs);
  const count = await store.incr(key);
  if (count === 1) {
    await store.expire(key, input.windowSec);
  } else {
    const ttl = await store.ttl(key);
    if (ttl === -1) {
      await store.expire(key, input.windowSec);
    }
  }

  if (count > input.limit) {
    const ttl = await store.ttl(key);
    throw new GraphQLError("Too many requests.", {
      extensions: {
        code: "RATE_LIMITED",
        retryAfterSeconds: Math.max(ttl, 1),
      },
    });
  }
}
