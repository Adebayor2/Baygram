import { requireUser } from "../../auth/requireUser.js";
import type { AppContext } from "../../graphql/context.js";
import {
  getHashtag,
  hashtagPosts,
  searchHashtags,
  searchUsers,
} from "./service.js";

export const searchResolvers = {
  Query: {
    searchUsers: async (
      _parent: unknown,
      args: { query: string; first?: number | null; after?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return searchUsers(user.id, args.query, args.first ?? null, args.after ?? null);
    },
    searchHashtags: async (
      _parent: unknown,
      args: { query: string; first?: number | null },
      ctx: AppContext
    ) => {
      requireUser(ctx);
      return searchHashtags(args.query, args.first ?? null);
    },
    hashtag: async (
      _parent: unknown,
      args: { name: string },
      ctx: AppContext
    ) => {
      requireUser(ctx);
      return getHashtag(args.name);
    },
    hashtagPosts: async (
      _parent: unknown,
      args: { name: string; first?: number | null; after?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return hashtagPosts(user.id, args.name, args.first ?? null, args.after ?? null);
    },
  },
  Post: {
    hashtags: async (
      post: { id: string },
      _args: unknown,
      ctx: AppContext
    ) => {
      const links = await ctx.prisma.postHashtag.findMany({
        where: { postId: post.id },
        include: { hashtag: true },
      });
      return links.map((link) => link.hashtag.name);
    },
    mentions: async (
      post: { id: string },
      _args: unknown,
      ctx: AppContext
    ) => {
      const links = await ctx.prisma.postMention.findMany({
        where: { postId: post.id },
        select: { mentionedId: true },
      });
      return Promise.all(
        links.map((link) => ctx.loaders.author.load(link.mentionedId))
      );
    },
  },
};
