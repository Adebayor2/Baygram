import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { redis } from "../../config/redis.js";
import { redisKeys } from "../../lib/redisKeys.js";
import { clampFirst, decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { canViewOwnerContent } from "../../lib/visibility.js";

export async function searchUsers(
  viewerId: string,
  query: string,
  firstArg: number | null,
  after: string | null
) {
  const normalized = query.trim().toLowerCase();
  const take = clampFirst(firstArg);
  if (normalized.length < 2) return { items: [], nextCursor: null };

  let cursorProfile = null;
  if (after) {
    const cursorId = decodeCursor(after);
    cursorProfile = await prisma.profile.findUnique({
      where: { id: cursorId },
      select: { id: true, followersCount: true },
    });
  }

  const blocks = await prisma.block.findMany({
    where: {
      OR: [{ blockerId: viewerId }, { blockedId: viewerId }],
    },
    select: { blockerId: true, blockedId: true },
  });
  const excluded = new Set<string>();
  for (const block of blocks) {
    excluded.add(block.blockerId);
    excluded.add(block.blockedId);
  }
  excluded.delete(viewerId);

  const where: Prisma.ProfileWhereInput = {
    AND: [
      {
        OR: [
          { username: { startsWith: normalized, mode: "insensitive" } },
          { fullName: { contains: normalized, mode: "insensitive" } },
        ],
      },
      ...(excluded.size > 0 ? [{ id: { notIn: [...excluded] } }] : []),
      ...(cursorProfile
        ? [{
            OR: [
              { followersCount: { lt: cursorProfile.followersCount } },
              {
                followersCount: cursorProfile.followersCount,
                id: { gt: cursorProfile.id },
              },
            ],
          }]
        : []),
    ],
  };

  if (!after) {
    const key = redisKeys.searchUsers(normalized);
    const cached = await redis.get(key);
    if (cached !== null) {
      try {
        const ids = JSON.parse(cached) as unknown;
        if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
          const profiles = await prisma.profile.findMany({
            where: { id: { in: ids }, ...where },
          });
          const byId = new Map(profiles.map((profile) => [profile.id, profile]));
          const items = ids.map((id) => byId.get(id)).filter((item) => item !== undefined);
          return { items, nextCursor: null };
        }
      } catch {
        await redis.del(key);
      }
    }
  }

  const rows = await prisma.profile.findMany({
    where,
    take: take + 1,
    orderBy: [{ followersCount: "desc" }, { id: "asc" }],
  });
  const hasNext = rows.length > take;
  const items = hasNext ? rows.slice(0, take) : rows;
  if (!after) {
    await redis.set(
      redisKeys.searchUsers(normalized),
      JSON.stringify(items.map((item) => item.id)),
      "EX",
      30
    );
  }
  return {
    items,
    nextCursor: hasNext ? encodeCursor(items[items.length - 1].id) : null,
  };
}

export async function searchHashtags(query: string, firstArg: number | null) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const first = Math.min(Math.max(firstArg ?? 10, 1), 10);
  const key = redisKeys.searchTags(normalized);
  const cached = await redis.get(key);
  if (cached !== null) {
    try {
      const names = JSON.parse(cached) as unknown;
      if (Array.isArray(names) && names.every((name) => typeof name === "string")) {
        return prisma.hashtag.findMany({
          where: { name: { in: names } },
          take: first,
        });
      }
    } catch {
      await redis.del(key);
    }
  }
  const rows = await prisma.hashtag.findMany({
    where: { name: { startsWith: normalized } },
    take: first,
    orderBy: [{ postsCount: "desc" }, { name: "asc" }],
  });
  await redis.set(
    key,
    JSON.stringify(rows.map((row) => row.name)),
    "EX",
    30
  );
  return rows;
}

export async function getHashtag(name: string) {
  return prisma.hashtag.findUnique({
    where: { name: name.trim().toLowerCase() },
  });
}

export async function hashtagPosts(
  viewerId: string,
  name: string,
  firstArg: number | null,
  after: string | null
) {
  const take = clampFirst(firstArg);
  const normalized = name.trim().toLowerCase();
  if (!normalized) return { items: [], nextCursor: null };
  const hashtag = await prisma.hashtag.findUnique({
    where: { name: normalized },
  });
  if (!hashtag) return { items: [], nextCursor: null };

  let cursorPost = null;
  if (after) {
    const cursorId = decodeCursor(after);
    cursorPost = await prisma.post.findUnique({
      where: { id: cursorId },
      select: { id: true, createdAt: true },
    });
  }
  const rows = await prisma.post.findMany({
    where: {
      AND: [
        { postHashtags: { some: { hashtagId: hashtag.id } } },
        ...(cursorPost
          ? [{
              OR: [
                { createdAt: { lt: cursorPost.createdAt } },
                { createdAt: cursorPost.createdAt, id: { lt: cursorPost.id } },
              ],
            }]
          : []),
      ],
    },
    take: take + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { media: { orderBy: { position: "asc" } } },
  });
  const visible = [];
  for (const post of rows) {
    if (await canViewOwnerContent(viewerId, post.authorId)) visible.push(post);
  }
  const hasNext = visible.length > take;
  const items = hasNext ? visible.slice(0, take) : visible;
  return {
    items,
    nextCursor: hasNext ? encodeCursor(items[items.length - 1].id) : null,
  };
}
