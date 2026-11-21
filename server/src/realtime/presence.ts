import { prisma } from "../config/db.js";
import { redis } from "../config/redis.js";

export async function connectPresence(userId: string): Promise<void> {
  await redis.incr(`presence:conn:${userId}`);
  await redis.expire(`presence:conn:${userId}`, 90);
}

export async function disconnectPresence(userId: string): Promise<void> {
  const connKey = `presence:conn:${userId}`;
  const lastSeenKey = `presence:lastseen:${userId}`;
  await redis.eval(
    `local remaining = redis.call('DECR', KEYS[1])
     if remaining <= 0 then
       redis.call('DEL', KEYS[1])
       redis.call('SET', KEYS[2], ARGV[1])
       return 0
     end
     redis.call('EXPIRE', KEYS[1], 90)
     return remaining`,
    2,
    connKey,
    lastSeenKey,
    new Date().toISOString()
  );
}

export async function getPresence(
  viewerId: string,
  ownerId: string
): Promise<{ isOnline: boolean; lastSeenAt: string | null }> {
  if (viewerId !== ownerId) {
    const block = await prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: ownerId },
          { blockerId: ownerId, blockedId: viewerId },
        ],
      },
      select: { blockerId: true },
    });
    if (block) return { isOnline: false, lastSeenAt: null };
  }
  if (viewerId !== ownerId) {
    const accepted = await prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId: viewerId,
          followingId: ownerId,
        },
      },
      select: { status: true },
    });
    if (accepted?.status !== "ACCEPTED") {
      const shared = await prisma.conversationMember.findMany({
        where: { userId: viewerId },
        select: { conversationId: true },
      });
      const ids = shared.map((item) => item.conversationId);
      if (ids.length === 0) {
        return { isOnline: false, lastSeenAt: null };
      }
      const partner = await prisma.conversationMember.findFirst({
        where: {
          conversationId: { in: ids },
          userId: ownerId,
        },
      });
      if (!partner) {
        return { isOnline: false, lastSeenAt: null };
      }
    }
  }

  const count = await redis.get(`presence:conn:${ownerId}`);
  if (count !== null && Number(count) > 0) {
    return { isOnline: true, lastSeenAt: null };
  }
  const lastSeenAt = await redis.get(`presence:lastseen:${ownerId}`);
  return { isOnline: false, lastSeenAt };
}
