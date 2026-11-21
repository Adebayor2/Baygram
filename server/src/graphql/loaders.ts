import DataLoader from "dataloader";
import { prisma } from "../config/db.js";

export type ViewerFollowStatus = "SELF" | "NONE" | "REQUESTED" | "FOLLOWING";

export interface AppLoaders {
  author: DataLoader<string, { id: string; username: string; fullName: string | null; bio: string | null; avatarUrl: string | null; isPrivate: boolean; createdAt: Date } | null>;
  viewerHasLiked: DataLoader<string, boolean>;
  viewerHasSaved: DataLoader<string, boolean>;
  followersCount: DataLoader<string, number>;
  followingCount: DataLoader<string, number>;
  viewerFollowStatus: DataLoader<string, ViewerFollowStatus>;
  followsViewer: DataLoader<string, boolean>;
  viewerIsBlocking: DataLoader<string, boolean>;
}

export function createLoaders(viewerId: string | null): AppLoaders {
  return {
    author: new DataLoader(async (profileIds) => {
      const profiles = await prisma.profile.findMany({
        where: { id: { in: [...profileIds] } },
      });
      const byId = new Map(profiles.map((profile) => [profile.id, profile]));
      return profileIds.map((id) => byId.get(id) ?? null);
    }),
    viewerHasLiked: new DataLoader(async (postIds) => {
      if (!viewerId) return postIds.map(() => false);
      const likes = await prisma.like.findMany({
        where: { userId: viewerId, postId: { in: [...postIds] } },
        select: { postId: true },
      });
      const liked = new Set(likes.map((like) => like.postId));
      return postIds.map((id) => liked.has(id));
    }),
    viewerHasSaved: new DataLoader(async (postIds) => {
      if (!viewerId) return postIds.map(() => false);
      const saved = await prisma.savedPost.findMany({
        where: { userId: viewerId, postId: { in: [...postIds] } },
        select: { postId: true },
      });
      const savedIds = new Set(saved.map((item) => item.postId));
      return postIds.map((id) => savedIds.has(id));
    }),
    followersCount: new DataLoader(async (profileIds) => {
      const profiles = await prisma.profile.findMany({
        where: { id: { in: [...profileIds] } },
        select: { id: true, followersCount: true },
      });
      const counts = new Map(
        profiles.map((profile) => [profile.id, profile.followersCount])
      );
      return profileIds.map((id) => counts.get(id) ?? 0);
    }),

    followingCount: new DataLoader(async (profileIds) => {
      const profiles = await prisma.profile.findMany({
        where: { id: { in: [...profileIds] } },
        select: { id: true, followingCount: true },
      });
      const counts = new Map(
        profiles.map((profile) => [profile.id, profile.followingCount])
      );
      return profileIds.map((id) => counts.get(id) ?? 0);
    }),

    viewerFollowStatus: new DataLoader(async (profileIds) => {
      if (!viewerId) return profileIds.map(() => "NONE" as const);

      const targets = profileIds.filter((id) => id !== viewerId);
      const follows =
        targets.length === 0
          ? []
          : await prisma.follow.findMany({
              where: {
                followerId: viewerId,
                followingId: { in: [...targets] },
              },
              select: { followingId: true, status: true },
            });
      const statuses = new Map(
        follows.map((follow) => [follow.followingId, follow.status])
      );

      return profileIds.map((id) => {
        if (id === viewerId) return "SELF" as const;
        const status = statuses.get(id);
        if (status === "ACCEPTED") return "FOLLOWING" as const;
        if (status === "PENDING") return "REQUESTED" as const;
        return "NONE" as const;
      });
    }),

    followsViewer: new DataLoader(async (profileIds) => {
      if (!viewerId) return profileIds.map(() => false);
      const follows = await prisma.follow.findMany({
        where: {
          followerId: { in: [...profileIds] },
          followingId: viewerId,
          status: "ACCEPTED",
        },
        select: { followerId: true },
      });
      const followerIds = new Set(follows.map((follow) => follow.followerId));
      return profileIds.map((id) => followerIds.has(id));
    }),

    viewerIsBlocking: new DataLoader(async (profileIds) => {
      if (!viewerId) return profileIds.map(() => false);
      const blocks = await prisma.block.findMany({
        where: {
          blockerId: viewerId,
          blockedId: { in: [...profileIds] },
        },
        select: { blockedId: true },
      });
      const blockedIds = new Set(blocks.map((block) => block.blockedId));
      return profileIds.map((id) => blockedIds.has(id));
    }),
  };
}
