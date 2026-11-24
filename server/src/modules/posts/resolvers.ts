import { requireUser } from "../../auth/requireUser.js";
import type { AppContext } from "../../graphql/context.js";
import { badUserInput } from "../../graphql/errors.js";
import { rateLimit } from "../../lib/rateLimit.js";
import { createPostInputSchema } from "../../lib/validators.js";
import {
  createPost,
  deletePost,
  getPost,
  getUserPosts,
  getHomeFeed,
  getExplore,
  updatePostCaption,
  type CreatePostInput,
} from "./service.js";

function parsePostInput(args: unknown): CreatePostInput {
  if (!isRecord(args) || !("input" in args)) {
    throw badUserInput("Post input is required.");
  }
  const parsed = createPostInputSchema.safeParse(args.input);
  if (!parsed.success) {
    throw badUserInput(parsed.error.issues[0]?.message ?? "Invalid post input.");
  }
  return parsed.data;
}

export const postResolvers = {
  Query: {
    post: async (
      _parent: unknown,
      args: { id: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getPost(user.id, args.id);
    },
    userPosts: async (
      _parent: unknown,
      args: { username: string; first?: number | null; after?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getUserPosts(user.id, args.username, args.first ?? null, args.after ?? null);
    },
    homeFeed: async (
      _parent: unknown,
      args: { first?: number | null; after?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getHomeFeed(user.id, args.first ?? null, args.after ?? null);
    },
    explore: async (
      _parent: unknown,
      args: { first?: number | null; after?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getExplore(user.id, args.first ?? null, args.after ?? null);
    },
  },
  Mutation: {
    createPost: async (
      _parent: unknown,
      args: unknown,
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      await rateLimit({
        scope: "createPost",
        id: user.id,
        limit: 10,
        windowSec: 60,
      });
      return createPost(user.id, parsePostInput(args));
    },
    updatePostCaption: async (
      _parent: unknown,
      args: { postId: string; caption?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return updatePostCaption(user.id, args.postId, args.caption);
    },
    deletePost: async (
      _parent: unknown,
      args: { postId: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return deletePost(user.id, args.postId);
    },
  },
  Post: {
    author: (
      post: { authorId: string },
      _args: unknown,
      ctx: AppContext
    ) => ctx.loaders.author.load(post.authorId),
    media: (post: { media: unknown[] }) => post.media,
    createdAt: (post: { createdAt: Date }) => post.createdAt.toISOString(),
  },
  Media: {
    durationSec: (media: { durationSec: number | null }) => media.durationSec,
  },
  Profile: {
    postsCount: (
      profile: { id: string },
      _args: unknown,
      ctx: AppContext
    ) => ctx.prisma.profile.findUnique({ where: { id: profile.id }, select: { postsCount: true } }).then((row) => row?.postsCount ?? 0),
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
