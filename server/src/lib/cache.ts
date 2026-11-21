import { redis } from "../config/redis.js";

export async function cacheGetOrSet<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
  decode: (value: unknown) => T
): Promise<T> {
  const cached = await redis.get(key);
  if (cached !== null) {
    console.debug("cache hit", { key });
    let value: unknown;
    try {
      value = JSON.parse(cached);
    } catch (error) {
      throw new Error(`Invalid JSON in cache entry "${key}".`, { cause: error });
    }
    return decode(value);
  }

  console.debug("cache miss", { key });
  const value = await loader();
  await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  return value;
}
