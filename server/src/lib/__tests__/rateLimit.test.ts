import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";

vi.mock("../../config/redis.js", () => ({ redis: {} }));

const { rateLimit, rateLimitKey } = await import("../rateLimit.js");
const configuredRedisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const redisUrl = new URL(configuredRedisUrl);
redisUrl.pathname = "/15";
const testRedis = new Redis(redisUrl.toString(), {
  lazyConnect: true,
  connectTimeout: 1500,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
});

let redisAvailable = false;
try {
  await testRedis.connect();
  await testRedis.ping();
  redisAvailable = true;
} catch (error) {
  console.warn("Skipping Redis rate-limit tests: Redis DB 15 is unreachable.", error);
  testRedis.disconnect();
}

const input = { scope: "test", id: "user-1", limit: 2, windowSec: 60 };

describe("rate limit window", () => {
  it("uses stable keys within a window and changes keys at its boundary", () => {
    expect(rateLimitKey(input, 60_000)).toBe("rl:test:user-1:60");
    expect(rateLimitKey(input, 119_999)).toBe("rl:test:user-1:60");
    expect(rateLimitKey(input, 120_000)).toBe("rl:test:user-1:120");
  });
});

describe.skipIf(!redisAvailable)("rate limit Redis storage", () => {
  beforeEach(async () => {
    await testRedis.flushdb();
  });

  it("allows the limit, rejects the next request, and sets an expiring key", async () => {
    const now = 1_700_000_000_000;
    await rateLimit(input, testRedis, now);
    await rateLimit(input, testRedis, now);
    await expect(rateLimit(input, testRedis, now)).rejects.toMatchObject({
      extensions: { code: "RATE_LIMITED" },
    });

    const key = rateLimitKey(input, now);
    const [count, ttl] = await Promise.all([testRedis.get(key), testRedis.ttl(key)]);
    expect(count).toBe("3");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(input.windowSec);
  });
});

afterAll(async () => {
  if (redisAvailable) await testRedis.quit();
  else testRedis.disconnect();
});
