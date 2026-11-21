import type { PrismaClient } from "@prisma/client";
import { prisma } from "../config/db.js";

interface VisibilityInput {
  viewerId: string | null;
  ownerId: string;
  ownerIsPrivate: boolean;
  isAcceptedFollower: boolean;
  blockedEitherWay: boolean;
}

export function decideVisibility({
  viewerId,
  ownerId,
  ownerIsPrivate,
  isAcceptedFollower,
  blockedEitherWay,
}: VisibilityInput): boolean {
  if (viewerId === ownerId) return true;
  if (!viewerId || blockedEitherWay) return false;
  return !ownerIsPrivate || isAcceptedFollower;
}

export async function canViewOwnerContent(
  viewerId: string | null,
  ownerId: string,
  client: PrismaClient = prisma
): Promise<boolean> {
  if (!viewerId) return false;
  if (viewerId === ownerId) return true;

  const [owner, follow, block] = await Promise.all([
    client.profile.findUnique({
      where: { id: ownerId },
      select: { isPrivate: true },
    }),
    client.follow.findUnique({
      where: {
        followerId_followingId: { followerId: viewerId, followingId: ownerId },
      },
      select: { status: true },
    }),
    client.block.findFirst({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: ownerId },
          { blockerId: ownerId, blockedId: viewerId },
        ],
      },
      select: { blockerId: true },
    }),
  ]);
  if (!owner) return false;

  return decideVisibility({
    viewerId,
    ownerId,
    ownerIsPrivate: owner.isPrivate,
    isAcceptedFollower: follow?.status === "ACCEPTED",
    blockedEitherWay: block !== null,
  });
}
