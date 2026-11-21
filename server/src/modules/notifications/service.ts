import { createHash } from "node:crypto";
import { NotificationType, Prisma } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { redis } from "../../config/redis.js";
import { badUserInput, forbidden, notFound } from "../../graphql/errors.js";
import { clampFirst, decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { emitToUser } from "../../realtime/emit.js";
import { notificationQueue } from "../../config/queues.js";

export interface NotifyInput {
  type: NotificationType;
  recipientId: string;
  actorId: string;
  postId?: string;
  commentId?: string;
}

function unreadKey(userId: string): string {
  return `notif:unread:${userId}`;
}

export async function notifyUser(input: NotifyInput): Promise<void> {
  if (input.recipientId === input.actorId) return;

  const postPart = input.postId ?? "";
  const commentPart = input.commentId ?? "";
  const jobId = createHash("sha256")
    .update(
      JSON.stringify([
        input.type,
        input.actorId,
        input.recipientId,
        postPart,
        commentPart,
      ])
    )
    .digest("hex");
  await notificationQueue.add(
    "notifications:create",
    input,
    {
      jobId,
    }
  );
}

export async function processNotificationJob(input: NotifyInput): Promise<void> {
  const blocked = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: input.actorId, blockedId: input.recipientId },
        { blockerId: input.recipientId, blockedId: input.actorId },
      ],
    },
  });
  if (blocked) return;

  const existing =
    input.type === NotificationType.LIKE ||
    input.type === NotificationType.FOLLOW
      ? await prisma.notification.findFirst({
      where: {
        recipientId: input.recipientId,
        actorId: input.actorId,
        type: input.type,
        ...(input.postId ? { postId: input.postId } : {}),
      },
      })
      : null;
  const notification =
    existing ??
    (await prisma.notification.create({
      data: {
        recipientId: input.recipientId,
        actorId: input.actorId,
        type: input.type,
        postId: input.postId ?? null,
        commentId: input.commentId ?? null,
      },
    }));
  if (!existing) {
    await redis.incr(unreadKey(input.recipientId));
    await redis.expire(unreadKey(input.recipientId), 86400);
  }
  const actor = await prisma.profile.findUnique({
    where: { id: input.actorId },
    select: { id: true, username: true, avatarUrl: true },
  });
  const count = await unreadNotificationsCount(input.recipientId);
  await emitToUser(input.recipientId, "notification:new", {
    id: notification.id,
    type: notification.type,
    actor: actor
      ? { id: actor.id, username: actor.username, avatarUrl: actor.avatarUrl }
      : { id: input.actorId, username: "", avatarUrl: null },
    postId: notification.postId,
    commentId: notification.commentId,
    createdAt: notification.createdAt.toISOString(),
  });
  await emitToUser(input.recipientId, "notification:unread", { count });
}

export async function removeNotifications(
  recipientId: string,
  actorId: string,
  type: NotificationType,
  postId?: string
): Promise<void> {
  const removed = await prisma.notification.deleteMany({
    where: {
      recipientId,
      actorId,
      type,
      ...(postId ? { postId } : {}),
    },
  });
  if (removed.count > 0) {
    const key = unreadKey(recipientId);
    const count = await redis.get(key);
    if (count !== null) {
      await redis.decrby(key, removed.count);
      await redis.expire(key, 86400);
    }
  }
}

export async function unreadNotificationsCount(userId: string): Promise<number> {
  const key = unreadKey(userId);
  const cached = await redis.get(key);
  if (cached !== null) {
    const count = Number(cached);
    return Number.isFinite(count) ? Math.max(count, 0) : 0;
  }
  const count = await prisma.notification.count({
    where: { recipientId: userId, readAt: null },
  });
  await redis.set(key, String(count), "EX", 86400);
  return count;
}

export async function getNotifications(
  viewerId: string,
  firstArg: number | null,
  after: string | null,
  unreadOnly: boolean
) {
  const take = clampFirst(firstArg);
  const args: Prisma.NotificationFindManyArgs = {
    where: {
      recipientId: viewerId,
      ...(unreadOnly ? { readAt: null } : {}),
    },
    take: take + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  };
  if (after) {
    args.cursor = { id: decodeCursor(after) };
    args.skip = 1;
  }
  const rows = await prisma.notification.findMany(args);
  const hasNext = rows.length > take;
  const items = hasNext ? rows.slice(0, take) : rows;
  return {
    items,
    nextCursor: hasNext ? encodeCursor(items[items.length - 1].id) : null,
  };
}

export async function markNotificationRead(
  viewerId: string,
  notificationId: string
): Promise<boolean> {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });
  if (!notification) throw notFound("Notification not found.");
  if (notification.recipientId !== viewerId) {
    throw forbidden("You can only read your own notifications.");
  }
  if (notification.readAt === null) {
    await prisma.notification.update({
      where: { id: notificationId },
      data: { readAt: new Date() },
    });
    const key = unreadKey(viewerId);
    const cached = await redis.get(key);
    if (cached !== null) {
      await redis.decr(key);
      await redis.expire(key, 86400);
    }
  }
  const count = await unreadNotificationsCount(viewerId);
  await emitToUser(viewerId, "notification:unread", { count });
  return true;
}

export async function markAllNotificationsRead(viewerId: string): Promise<boolean> {
  await prisma.notification.updateMany({
    where: { recipientId: viewerId, readAt: null },
    data: { readAt: new Date() },
  });
  await redis.del(unreadKey(viewerId));
  await emitToUser(viewerId, "notification:unread", { count: 0 });
  return true;
}
