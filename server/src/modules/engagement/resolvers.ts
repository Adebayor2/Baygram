import { requireUser } from "../../auth/requireUser.js";
import type { AppContext } from "../../graphql/context.js";
import { badUserInput } from "../../graphql/errors.js";
import {
  addComment,
  deleteComment,
  getComments,
  getLikers,
  getReplies,
  getSavedPosts,
  likePost,
  savePost,
  unlikePost,
  unsavePost,
} from "./service.js";

export const engagementResolvers = {
  Query: {
    comments: async (
      _parent: unknown,
      args: { postId: string; first?: number | null; after?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getComments(user.id, args.postId, args.first ?? null, args.after ?? null);
    },
    replies: async (
      _parent: unknown,
      args: { commentId: string; first?: number | null; after?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getReplies(user.id, args.commentId, args.first ?? null, args.after ?? null);
    },
    likers: async (
      _parent: unknown,
      args: { postId: string; first?: number | null; after?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getLikers(user.id, args.postId, args.first ?? null, args.after ?? null);
    },
    savedPosts: async (
      _parent: unknown,
      args: { first?: number | null; after?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getSavedPosts(user.id, args.first ?? null, args.after ?? null);
    },
  },
  Mutation: {
    likePost: async (
      _parent: unknown,
      args: { postId: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return likePost(user.id, args.postId);
    },
    unlikePost: async (
      _parent: unknown,
      args: { postId: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return unlikePost(user.id, args.postId);
    },
    addComment: async (
      _parent: unknown,
      args: { postId: string; body: string; parentId?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      if (!args.body || args.body.trim().length === 0) {
        throw badUserInput("Comment body must be between 1 and 500 characters.");
      }
      return addComment(user.id, args.postId, args.body, args.parentId);
    },
    deleteComment: async (
      _parent: unknown,
      args: { commentId: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return deleteComment(user.id, args.commentId);
    },
    savePost: async (
      _parent: unknown,
      args: { postId: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return savePost(user.id, args.postId);
    },
    unsavePost: async (
      _parent: unknown,
      args: { postId: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return unsavePost(user.id, args.postId);
    },
  },
  Post: {
    viewerHasLiked: (
      post: { id: string },
      _args: unknown,
      ctx: AppContext
    ) => ctx.loaders.viewerHasLiked.load(post.id),
    viewerHasSaved: (
      post: { id: string },
      _args: unknown,
      ctx: AppContext
    ) => ctx.loaders.viewerHasSaved.load(post.id),
    comments: async (
      post: { id: string },
      args: { first?: number | null; after?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getComments(user.id, post.id, args.first ?? null, args.after ?? null);
    },
  },
  Comment: {
    post: async (
      comment: { postId: string },
      _args: unknown,
      ctx: AppContext
    ) => ctx.prisma.post.findUnique({
      where: { id: comment.postId },
      include: { media: { orderBy: { position: "asc" } } },
    }),
    author: (
      comment: { authorId: string },
      _args: unknown,
      ctx: AppContext
    ) => ctx.loaders.author.load(comment.authorId),
    createdAt: (comment: { createdAt: Date }) => comment.createdAt.toISOString(),
  },
};
