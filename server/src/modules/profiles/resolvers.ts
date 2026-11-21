import { requireUser } from "../../auth/requireUser.js";
import type { AppContext } from "../../graphql/context.js";
import { badUserInput } from "../../graphql/errors.js";
import {
  createProfileInputSchema,
  updateProfileInputSchema,
} from "../../lib/validators.js";
import {
  createProfile,
  getProfileByUsername,
  updateProfile,
} from "./service.js";
import { getPresence } from "../../realtime/presence.js";

function parseInput<T>(
  parsed: { success: true; data: T } | { success: false; error: { issues: { message: string }[] } }
): T {
  if (!parsed.success) {
    throw badUserInput(parsed.error.issues[0]?.message ?? "Invalid input.");
  }
  return parsed.data;
}

export const profileResolvers = {
  Query: {
    me: async (_parent: unknown, _args: unknown, ctx: AppContext) => {
      const user = requireUser(ctx);
      return ctx.prisma.profile.findUnique({ where: { id: user.id } });
    },
    profile: async (
      _parent: unknown,
      args: { username: string },
      ctx: AppContext
    ) => {
      const viewer = requireUser(ctx);
      const profile = await getProfileByUsername(args.username);
      if (!profile || profile.id === viewer.id) return profile;

      const targetBlockedViewer = await ctx.prisma.block.findUnique({
        where: {
          blockerId_blockedId: {
            blockerId: profile.id,
            blockedId: viewer.id,
          },
        },
        select: { blockerId: true },
      });
      return targetBlockedViewer ? null : profile;
    },
    presence: async (
      _parent: unknown,
      args: { username: string },
      ctx: AppContext
    ) => {
      const viewer = requireUser(ctx);
      const profile = await ctx.prisma.profile.findUnique({
        where: { username: args.username.trim().toLowerCase() },
        select: { id: true },
      });
      if (!profile) {
        return { isOnline: false, lastSeenAt: null };
      }
      return getPresence(viewer.id, profile.id);
    },
  },

  Mutation: {
    createProfile: async (_parent: unknown, args: unknown, ctx: AppContext) => {
      const user = requireUser(ctx);
      const input = parseInput(createProfileInputSchema.safeParse(args));
      return createProfile(user.id, input);
    },
    updateProfile: async (_parent: unknown, args: unknown, ctx: AppContext) => {
      const user = requireUser(ctx);
      if (!isRecord(args) || !("input" in args)) {
        throw badUserInput("Profile input is required.");
      }
      const input = parseInput(updateProfileInputSchema.safeParse(args.input));
      return updateProfile(user.id, input);
    },
  },

  Profile: {
    createdAt: (profile: { createdAt: Date }) => profile.createdAt.toISOString(),
    followersCount: (
      profile: { id: string },
      _args: unknown,
      ctx: AppContext
    ) => ctx.loaders.followersCount.load(profile.id),
    followingCount: (
      profile: { id: string },
      _args: unknown,
      ctx: AppContext
    ) => ctx.loaders.followingCount.load(profile.id),
    viewerFollowStatus: (
      profile: { id: string },
      _args: unknown,
      ctx: AppContext
    ) => ctx.loaders.viewerFollowStatus.load(profile.id),
    followsViewer: (
      profile: { id: string },
      _args: unknown,
      ctx: AppContext
    ) => ctx.loaders.followsViewer.load(profile.id),
    viewerIsBlocking: (
      profile: { id: string },
      _args: unknown,
      ctx: AppContext
    ) => ctx.loaders.viewerIsBlocking.load(profile.id),
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
