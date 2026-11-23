import { requireUser } from "../../auth/requireUser.js";
import type { AppContext } from "../../graphql/context.js";
import {
  createStory,
  deleteStory,
  getStoriesTray,
  getStoryViewers,
  getUserStories,
  viewStory,
} from "./service.js";

export const storyResolvers = {
  Query: {
    storiesTray: (_parent: unknown, _args: unknown, ctx: AppContext) => {
      const user = requireUser(ctx);
      return getStoriesTray(user.id);
    },
    userStories: (
      _parent: unknown,
      args: { username: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getUserStories(user.id, args.username);
    },
    storyViewers: (
      _parent: unknown,
      args: { storyId: string; first?: number | null; after?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getStoryViewers(
        user.id,
        args.storyId,
        args.first ?? null,
        args.after ?? null
      );
    },
  },
  Mutation: {
    createStory: (
      _parent: unknown,
      args: { media: { publicId: string; type: "IMAGE" | "VIDEO" }; caption?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return createStory(user.id, args.media, args.caption);
    },
    deleteStory: (
      _parent: unknown,
      args: { storyId: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return deleteStory(user.id, args.storyId);
    },
    viewStory: (
      _parent: unknown,
      args: { storyId: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return viewStory(user.id, args.storyId);
    },
  },
  Story: {
    author: (story: { authorId: string }, _args: unknown, ctx: AppContext) =>
      ctx.loaders.author.load(story.authorId),
    media: (story: {
      mediaPublicId: string;
      mediaUrl: string;
      mediaType: "IMAGE" | "VIDEO";
      width: number | null;
      height: number | null;
      durationSec: number | null;
    }) => ({
      publicId: story.mediaPublicId,
      url: story.mediaUrl,
      type: story.mediaType,
      width: story.width,
      height: story.height,
      durationSec: story.durationSec,
    }),
    createdAt: (story: { createdAt: Date }) => story.createdAt.toISOString(),
    expiresAt: (story: { expiresAt: Date }) => story.expiresAt.toISOString(),
  },
  StoryGroup: {
    author: (group: { authorId: string }, _args: unknown, ctx: AppContext) =>
      ctx.loaders.author.load(group.authorId),
  },
};
