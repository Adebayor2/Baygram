import type { Redis } from "ioredis";
import type { Request } from "express";
import { prisma } from "../config/db.js";
import { redis } from "../config/redis.js";
import { getUserFromRequest, type AuthUser } from "../auth/getUser.js";
import { createLoaders, type AppLoaders } from "./loaders.js";

export interface AppContext {
  prisma: typeof prisma;
  redis: Redis;
  user: AuthUser | null;
  loaders: AppLoaders;
}

export async function buildContext(req: Request): Promise<AppContext> {
  const user = await getUserFromRequest(req);
  return { prisma, redis, user, loaders: createLoaders(user?.id ?? null) };
}