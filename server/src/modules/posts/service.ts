import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { redis } from "../../config/redis.js";
import { redisKeys } from "../../lib/redisKeys.js";
import { badUserInput, forbidden, notFound } from "../../graphql/errors.js";
import { canViewOwnerContent } from "../../lib/visibility.js";
import { clampFirst, decodeCursor, encodeCursor } from "../../lib/cursor.js";
import {
  describeOwnedMedia,
  deleteMedia,
  type MediaType,
  type OwnedMedia,
} from "../media/service.js";
import { extractHashtags, extractMentions } from "../../lib/hashtags.js";
import { NotificationType } from "@prisma/client";
import { notifyUser } from "../notifications/service.js";

export interface CreatePostInput {
  caption?: string | null;
  media: Array<{ publicId: string; type: MediaType }>;
}

export async function createPost(
  authorId: string,
  input: CreatePostInput
) {
  const media: OwnedMedia[] = [];
  for (const item of input.media) {
    const described = await describeOwnedMedia(
      authorId,
      item,
      item.type === "IMAGE" ? ["POST_IMAGE"] : ["POST_VIDEO"]
    );
    media.push(described);
  }

  const post = await prisma.$transaction(async (tx) => {
    const post = await tx.post.create({
      data: {
        authorId,
        caption: input.caption?.trim() || null,
        media: {
          create: media.map((item, position) => ({
            publicId: item.publicId,
            url: item.url,
            type: item.type,
            width: item.width,
            height: item.height,
            durationSec: item.durationSec,
            position,
          })),
        },
      },
      include: { media: { orderBy: { position: "asc" } } },
    });
    await tx.profile.update({
      where: { id: authorId },
      data: { postsCount: { increment: 1 } },
    });
    await syncPostTags(tx, post.id, authorId, post.caption);
    return post;
  }, { timeout: 15_000 });
  await invalidateFeedCache(authorId);
  await notifyPostMentions(authorId, post.id);
  return post;
}

export async function getPost(viewerId: string, postId: string) {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: { media: { orderBy: { position: "asc" } } },
  });
  if (!post) return null;
  if (!(await canViewOwnerContent(viewerId, post.authorId))) return null;
  return post;
}

export async function getUserPosts(
  viewerId: string,
  username: string,
  first: number | null,
  after: string | null
) {
  const owner = await prisma.profile.findUnique({
    where: { username: username.trim().toLowerCase() },
  });
  if (!owner) return { items: [], nextCursor: null };
  if (!(await canViewOwnerContent(viewerId, owner.id))) {
    throw forbidden("You cannot view posts from this account.");
  }

  const take = clampFirst(first);
  const args: Prisma.PostFindManyArgs = {
    where: { authorId: owner.id },
    take: take + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { media: { orderBy: { position: "asc" } } },
  };
  if (after) {
    args.cursor = { id: decodeCursor(after) };
    args.skip = 1;
  }

  const rows = await prisma.post.findMany(args);
  const hasNext = rows.length > take;
  const items = hasNext ? rows.slice(0, take) : rows;
  return {
    items,
    nextCursor: hasNext ? encodeCursor(items[items.length - 1].id) : null,
  };
}

export async function updatePostCaption(
  viewerId: string,
  postId: string,
  caption: string | null | undefined
) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw notFound("Post not found.");
  if (post.authorId !== viewerId) throw forbidden("Only the author can edit this post.");
  if (caption !== undefined && caption !== null && caption.length > 2200) {
    throw badUserInput("Caption must be at most 2200 characters.");
  }
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.post.update({
      where: { id: postId },
      data: { caption: caption?.trim() || null },
      include: { media: { orderBy: { position: "asc" } } },
    });
    await syncPostTags(tx, postId, viewerId, result.caption);
    return result;
  }, { timeout: 15_000 });
  await notifyPostMentions(viewerId, postId);
  return updated;
}

export async function deletePost(viewerId: string, postId: string) {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: { media: true },
  });
  if (!post) throw notFound("Post not found.");
  if (post.authorId !== viewerId) throw forbidden("Only the author can delete this post.");

  await prisma.$transaction(async (tx) => {
    const tags = await tx.postHashtag.findMany({
      where: { postId },
      include: { hashtag: true },
    });
    for (const tag of tags) {
      await tx.hashtag.update({
        where: { id: tag.hashtagId },
        data: { postsCount: { decrement: 1 } },
      });
    }
    await tx.post.delete({ where: { id: postId } });
    await tx.profile.update({
      where: { id: viewerId },
      data: { postsCount: { decrement: 1 } },
    });
  });
  await Promise.all(post.media.map((item) => deleteMedia(item.publicId, item.type)));
  await invalidateFeedCache(viewerId);
  return true;
}

async function syncPostTags(
  tx: Prisma.TransactionClient,
  postId: string,
  authorId: string,
  caption: string | null
): Promise<void> {
  const hashtagNames = extractHashtags(caption);
  const oldLinks = await tx.postHashtag.findMany({
    where: { postId },
    include: { hashtag: true },
  });
  const oldNames = new Set(oldLinks.map((link) => link.hashtag.name));
  const newNames = new Set(hashtagNames);

  for (const name of oldNames) {
    if (newNames.has(name)) continue;
    const hashtag = await tx.hashtag.findUnique({ where: { name } });
    if (hashtag) {
      await tx.hashtag.update({
        where: { id: hashtag.id },
        data: { postsCount: { decrement: 1 } },
      });
    }
  }

  await tx.postHashtag.deleteMany({ where: { postId } });
  for (const name of hashtagNames) {
    const hashtag = await tx.hashtag.upsert({
      where: { name },
      create: { name, postsCount: 1 },
      update: {
        postsCount: oldNames.has(name)
          ? undefined
          : { increment: 1 },
      },
    });
    await tx.postHashtag.create({
      data: { postId, hashtagId: hashtag.id },
    });
  }

  await tx.postMention.deleteMany({ where: { postId } });
  const mentionNames = extractMentions(caption);
  if (mentionNames.length === 0) return;

  const profiles = await tx.profile.findMany({
    where: { username: { in: mentionNames } },
  });
  for (const profile of profiles) {
    if (profile.id === authorId) continue;
    const block = await tx.block.findFirst({
      where: {
        OR: [
          { blockerId: authorId, blockedId: profile.id },
          { blockerId: profile.id, blockedId: authorId },
        ],
      },
      select: { blockerId: true },
    });
    if (block) continue;
    await tx.postMention.create({
      data: { postId, mentionedId: profile.id },
    });
  }
}

async function notifyPostMentions(authorId: string, postId: string): Promise<void> {
  const mentions = await prisma.postMention.findMany({
    where: { postId },
    select: { mentionedId: true },
  });
  for (const mention of mentions) {
    await notifyUser({
      type: NotificationType.MENTION,
      recipientId: mention.mentionedId,
      actorId: authorId,
      postId,
    });
  }
}

export async function invalidateFeedCache(userId: string): Promise<void> {
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      `cache:feed:${userId}:*`,
      "COUNT",
      100
    );
    cursor = nextCursor;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}

function postCursorWhere(cursorPost: { createdAt: Date; id: string }): Prisma.PostWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursorPost.createdAt } },
      { createdAt: cursorPost.createdAt, id: { lt: cursorPost.id } },
    ],
  };
}

async function hydratePosts(ids: string[]): Promise<(typeof prisma.post extends never ? never : Awaited<ReturnType<typeof prisma.post.findMany>>[number])[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.post.findMany({
    where: { id: { in: ids } },
    include: { media: { orderBy: { position: "asc" } } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row) => row !== undefined);
}

export async function getHomeFeed(
  viewerId: string,
  firstArg: number | null,
  after: string | null
) {
  const take = clampFirst(firstArg);
  let cursorPost = null;
  if (after) {
    const cursorId = decodeCursor(after);
    cursorPost = await prisma.post.findUnique({
      where: { id: cursorId },
      select: { id: true, createdAt: true },
    });
    if (!cursorPost) throw badUserInput("Invalid cursor.");
  }

  const blocked = await prisma.block.findMany({
    where: {
      OR: [{ blockerId: viewerId }, { blockedId: viewerId }],
    },
    select: { blockerId: true, blockedId: true },
  });
  const blockedIds = new Set<string>();
  for (const block of blocked) {
    blockedIds.add(block.blockerId);
    blockedIds.add(block.blockedId);
  }
  blockedIds.delete(viewerId);

  const baseWhere: Prisma.PostWhereInput = {
    AND: [
      {
        OR: [
          { authorId: viewerId },
          {
            author: {
              followers: {
                some: { followerId: viewerId, status: "ACCEPTED" },
              },
            },
          },
        ],
      },
      ...(cursorPost ? [postCursorWhere(cursorPost)] : []),
    ],
    ...(blockedIds.size > 0 ? { authorId: { notIn: [...blockedIds] } } : {}),
  };

  if (!after) {
    const key = redisKeys.feedCache(viewerId, take);
    const cached = await redis.get(key);
    if (cached !== null) {
      let ids: unknown;
      try {
        ids = JSON.parse(cached);
      } catch {
        await redis.del(key);
        ids = null;
      }
      if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
        const rows = await hydratePosts(ids);
        const visible = [];
        for (const row of rows) {
          if (!(await canViewOwnerContent(viewerId, row.authorId))) continue;
          visible.push(row);
        }
        return { items: visible, nextCursor: null };
      }
    }
  }

  const rows = await prisma.post.findMany({
    where: baseWhere,
    take: take + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { media: { orderBy: { position: "asc" } } },
  });
  const hasNext = rows.length > take;
  const items = hasNext ? rows.slice(0, take) : rows;
  const result = {
    items,
    nextCursor: hasNext ? encodeCursor(items[items.length - 1].id) : null,
  };

  if (!after) {
    await redis.set(
      redisKeys.feedCache(viewerId, take),
      JSON.stringify(items.map((item) => item.id)),
      "EX",
      30
    );
  }
  return result;
}

export async function getExplore(
  viewerId: string,
  firstArg: number | null,
  after: string | null
) {
  const take = clampFirst(firstArg);
  const trendingCount = await redis.zcard("explore:trending");
  if (trendingCount > 0) {
    let offset = 0;
    if (after) {
      if (!/^\d+$/.test(after)) throw badUserInput("Invalid cursor.");
      offset = Number(after);
    }
    const ids = await redis.zrevrange(
      "explore:trending",
      offset,
      offset + take - 1
    );
    if (ids.length > 0) {
      const rows = await hydratePosts(ids);
      const items = [];
      for (const post of rows) {
        if (post.authorId === viewerId) continue;
        if (!(await canViewOwnerContent(viewerId, post.authorId))) continue;
        items.push(post);
        if (items.length === take) break;
      }
      const nextOffset = offset + ids.length;
      const hasNext = nextOffset < trendingCount;
      return {
        items,
        nextCursor: hasNext ? String(nextOffset) : null,
      };
    }
  }

  let cursorPost = null;
  if (after) {
    const cursorId = decodeCursor(after);
    cursorPost = await prisma.post.findUnique({
      where: { id: cursorId },
      select: { id: true, createdAt: true },
    });
    if (!cursorPost) throw badUserInput("Invalid cursor.");
  }

  const blocked = await prisma.block.findMany({
    where: {
      OR: [{ blockerId: viewerId }, { blockedId: viewerId }],
    },
    select: { blockerId: true, blockedId: true },
  });
  const blockedIds = new Set<string>();
  for (const block of blocked) {
    blockedIds.add(block.blockerId);
    blockedIds.add(block.blockerId);
    blockedIds.add(block.blockedId);
  }
  blockedIds.delete(viewerId);

  const rows = await prisma.post.findMany({
    where: {
      AND: [
        { authorId: { not: viewerId } },
        { author: { isPrivate: false } },
        ...(blockedIds.size > 0
          ? [{ authorId: { notIn: [...blockedIds] } }]
          : []),
        ...(cursorPost ? [postCursorWhere(cursorPost)] : []),
      ],
    },
    take: take + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { media: { orderBy: { position: "asc" } } },
  });
  const hasNext = rows.length > take;
  const items = hasNext ? rows.slice(0, take) : rows;
  return {
    items,
    nextCursor: hasNext ? encodeCursor(items[items.length - 1].id) : null,
  };
}
