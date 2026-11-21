import { FollowStatus, Prisma, type Profile } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { forbidden, notFound, badUserInput } from "../../graphql/errors.js";
import { clampFirst, decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { canViewOwnerContent } from "../../lib/visibility.js";
import { invalidateFeedCache } from "../posts/service.js";
import { NotificationType } from "@prisma/client";
import { notifyUser, removeNotifications } from "../notifications/service.js";

interface ProfilePage {
  items: Profile[];
  nextCursor: string | null;
}

interface FollowCursor {
  followerId: string;
  followingId: string;
  status: FollowStatus;
  createdAt: Date;
}

async function findProfile(username: string): Promise<Profile> {
  const profile = await prisma.profile.findUnique({
    where: { username: username.trim().toLowerCase() },
  });
  if (!profile) throw notFound("Profile not found.");
  return profile;
}

function assertNotSelf(viewerId: string, targetId: string): void {
  if (viewerId === targetId) {
    throw badUserInput("You cannot perform this action on yourself.");
  }
}

async function ensureCanFollow(viewerId: string, targetId: string): Promise<void> {
  const [targetBlockedViewer, viewerBlockedTarget] = await Promise.all([
    prisma.block.findUnique({
      where: {
        blockerId_blockedId: { blockerId: targetId, blockedId: viewerId },
      },
      select: { blockerId: true },
    }),
    prisma.block.findUnique({
      where: {
        blockerId_blockedId: { blockerId: viewerId, blockedId: targetId },
      },
      select: { blockerId: true },
    }),
  ]);
  if (targetBlockedViewer) throw notFound("Profile not found.");
  if (viewerBlockedTarget) throw forbidden("Unblock this profile before following.");
}

export async function followProfile(
  viewerId: string,
  username: string
): Promise<Profile> {
  const target = await findProfile(username);
  assertNotSelf(viewerId, target.id);
  await ensureCanFollow(viewerId, target.id);

  const status = target.isPrivate
    ? FollowStatus.PENDING
    : FollowStatus.ACCEPTED;
  let created = false;
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.follow.findUnique({
        where: {
          followerId_followingId: {
            followerId: viewerId,
            followingId: target.id,
          },
        },
      });
      if (existing) return;
      created = true;

      await tx.follow.create({
        data: {
          followerId: viewerId,
          followingId: target.id,
          status,
        },
      });
      if (status === FollowStatus.ACCEPTED) {
        await tx.profile.update({
          where: { id: viewerId },
          data: { followingCount: { increment: 1 } },
        });
        await tx.profile.update({
          where: { id: target.id },
          data: { followersCount: { increment: 1 } },
        });
      }
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await prisma.follow.findUnique({
        where: {
          followerId_followingId: {
            followerId: viewerId,
            followingId: target.id,
          },
        },
      });
      if (existing) return target;
    }
    throw error;
  }
  await invalidateFeedCache(viewerId);
  if (created) {
    await notifyUser({
      type: status === FollowStatus.PENDING
        ? NotificationType.FOLLOW_REQUEST
        : NotificationType.FOLLOW,
      recipientId: target.id,
      actorId: viewerId,
    });
  }

  return target;
}

export async function unfollowProfile(
  viewerId: string,
  username: string
): Promise<Profile> {
  const target = await findProfile(username);
  assertNotSelf(viewerId, target.id);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId: viewerId,
          followingId: target.id,
        },
      },
    });
    if (!existing) return;

    await tx.follow.delete({
      where: {
        followerId_followingId: {
          followerId: viewerId,
          followingId: target.id,
        },
      },
    });
    if (existing.status === FollowStatus.ACCEPTED) {
      await tx.profile.update({
        where: { id: viewerId },
        data: { followingCount: { decrement: 1 } },
      });
      await tx.profile.update({
        where: { id: target.id },
        data: { followersCount: { decrement: 1 } },
      });
    }
  });
  await invalidateFeedCache(viewerId);
  await Promise.all([
    removeNotifications(
      target.id,
      viewerId,
      NotificationType.FOLLOW
    ),
    removeNotifications(
      target.id,
      viewerId,
      NotificationType.FOLLOW_REQUEST
    ),
  ]);

  return target;
}

export async function acceptFollowRequest(
  ownerId: string,
  username: string
): Promise<Profile> {
  const requester = await findProfile(username);
  assertNotSelf(ownerId, requester.id);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId: requester.id,
          followingId: ownerId,
        },
      },
    });
    if (!existing) throw notFound("Follow request not found.");
    if (existing.status === FollowStatus.ACCEPTED) return;
    if (existing.status !== FollowStatus.PENDING) {
      throw notFound("Follow request not found.");
    }

    const updated = await tx.follow.updateMany({
      where: {
        followerId: requester.id,
        followingId: ownerId,
        status: FollowStatus.PENDING,
      },
      data: { status: FollowStatus.ACCEPTED },
    });
    if (updated.count === 1) {
      await tx.profile.update({
        where: { id: ownerId },
        data: { followersCount: { increment: 1 } },
      });
      await tx.profile.update({
        where: { id: requester.id },
        data: { followingCount: { increment: 1 } },
      });
    }
  });
  await Promise.all([
    invalidateFeedCache(ownerId),
    invalidateFeedCache(requester.id),
  ]);
  await removeNotifications(
    ownerId,
    requester.id,
    NotificationType.FOLLOW_REQUEST
  );
  await notifyUser({
    type: NotificationType.FOLLOW_ACCEPTED,
    recipientId: requester.id,
    actorId: ownerId,
  });

  return requester;
}

export async function rejectFollowRequest(
  ownerId: string,
  username: string
): Promise<Profile> {
  const requester = await findProfile(username);
  assertNotSelf(ownerId, requester.id);
  const deleted = await prisma.follow.deleteMany({
    where: {
      followerId: requester.id,
      followingId: ownerId,
      status: FollowStatus.PENDING,
    },
  });
  if (deleted.count === 0) throw notFound("Follow request not found.");
  await removeNotifications(
    ownerId,
    requester.id,
    NotificationType.FOLLOW_REQUEST
  );
  return requester;
}

export async function blockProfile(
  blockerId: string,
  username: string
): Promise<Profile> {
  const target = await findProfile(username);
  assertNotSelf(blockerId, target.id);

  await prisma.$transaction(async (tx) => {
    const relationships = await tx.follow.findMany({
      where: {
        OR: [
          { followerId: blockerId, followingId: target.id },
          { followerId: target.id, followingId: blockerId },
        ],
      },
    });
    await tx.follow.deleteMany({
      where: {
        OR: [
          { followerId: blockerId, followingId: target.id },
          { followerId: target.id, followingId: blockerId },
        ],
      },
    });

    for (const relationship of relationships) {
      if (relationship.status !== FollowStatus.ACCEPTED) continue;
      await tx.profile.update({
        where: { id: relationship.followerId },
        data: { followingCount: { decrement: 1 } },
      });
      await tx.profile.update({
        where: { id: relationship.followingId },
        data: { followersCount: { decrement: 1 } },
      });
    }

    await tx.block.upsert({
      where: {
        blockerId_blockedId: { blockerId, blockedId: target.id },
      },
      create: { blockerId, blockedId: target.id },
      update: {},
    });
  });
  await Promise.all([
    invalidateFeedCache(blockerId),
    invalidateFeedCache(target.id),
  ]);

  return target;
}

export async function unblockProfile(
  blockerId: string,
  username: string
): Promise<Profile> {
  const target = await findProfile(username);
  assertNotSelf(blockerId, target.id);
  await prisma.block.deleteMany({
    where: { blockerId, blockedId: target.id },
  });
  await Promise.all([
    invalidateFeedCache(blockerId),
    invalidateFeedCache(target.id),
  ]);
  return target;
}

async function visibleOwner(
  viewerId: string,
  username: string
): Promise<Profile> {
  const owner = await findProfile(username);
  if (!(await canViewOwnerContent(viewerId, owner.id))) {
    throw forbidden("You cannot view this profile's lists.");
  }
  return owner;
}

function cursorBoundary(
  cursor: FollowCursor,
  orderedId: "followerId" | "followingId"
): Prisma.FollowWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      {
        createdAt: cursor.createdAt,
        [orderedId]: { lt: cursor[orderedId] },
      },
    ],
  };
}

export async function listFollowers(
  viewerId: string,
  username: string,
  firstArg: number | null | undefined,
  after: string | null | undefined
): Promise<ProfilePage> {
  const owner = await visibleOwner(viewerId, username);
  const first = clampFirst(firstArg);
  const afterId = after ? decodeCursor(after) : null;
  const cursor = afterId
    ? await prisma.follow.findUnique({
        where: {
          followerId_followingId: {
            followerId: afterId,
            followingId: owner.id,
          },
        },
      })
    : null;
  if (afterId && (!cursor || cursor.status !== FollowStatus.ACCEPTED)) {
    throw badUserInput("Invalid cursor.");
  }

  const where: Prisma.FollowWhereInput = {
    followingId: owner.id,
    status: FollowStatus.ACCEPTED,
    ...(cursor ? cursorBoundary(cursor, "followerId") : {}),
  };
  const rows = await prisma.follow.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { followerId: "desc" }],
    take: first + 1,
    include: { follower: true },
  });
  const page = rows.slice(0, first);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => row.follower),
    nextCursor:
      rows.length > first && last ? encodeCursor(last.followerId) : null,
  };
}

export async function listFollowing(
  viewerId: string,
  username: string,
  firstArg: number | null | undefined,
  after: string | null | undefined
): Promise<ProfilePage> {
  const owner = await visibleOwner(viewerId, username);
  const first = clampFirst(firstArg);
  const afterId = after ? decodeCursor(after) : null;
  const cursor = afterId
    ? await prisma.follow.findUnique({
        where: {
          followerId_followingId: {
            followerId: owner.id,
            followingId: afterId,
          },
        },
      })
    : null;
  if (afterId && (!cursor || cursor.status !== FollowStatus.ACCEPTED)) {
    throw badUserInput("Invalid cursor.");
  }

  const where: Prisma.FollowWhereInput = {
    followerId: owner.id,
    status: FollowStatus.ACCEPTED,
    ...(cursor ? cursorBoundary(cursor, "followingId") : {}),
  };
  const rows = await prisma.follow.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { followingId: "desc" }],
    take: first + 1,
    include: { following: true },
  });
  const page = rows.slice(0, first);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => row.following),
    nextCursor:
      rows.length > first && last ? encodeCursor(last.followingId) : null,
  };
}

export async function listFollowRequests(
  ownerId: string,
  firstArg: number | null | undefined,
  after: string | null | undefined
): Promise<ProfilePage> {
  const first = clampFirst(firstArg);
  const afterId = after ? decodeCursor(after) : null;
  const cursor = afterId
    ? await prisma.follow.findUnique({
        where: {
          followerId_followingId: {
            followerId: afterId,
            followingId: ownerId,
          },
        },
      })
    : null;
  if (afterId && (!cursor || cursor.status !== FollowStatus.PENDING)) {
    throw badUserInput("Invalid cursor.");
  }

  const where: Prisma.FollowWhereInput = {
    followingId: ownerId,
    status: FollowStatus.PENDING,
    ...(cursor ? cursorBoundary(cursor, "followerId") : {}),
  };
  const rows = await prisma.follow.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { followerId: "desc" }],
    take: first + 1,
    include: { follower: true },
  });
  const page = rows.slice(0, first);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => row.follower),
    nextCursor:
      rows.length > first && last ? encodeCursor(last.followerId) : null,
  };
}
