import { requireUser } from "../../auth/requireUser.js";
import type { AppContext } from "../../graphql/context.js";
import {
  acceptFollowRequest,
  blockProfile,
  followProfile,
  listFollowers,
  listFollowing,
  listFollowRequests,
  rejectFollowRequest,
  unblockProfile,
  unfollowProfile,
} from "./service.js";

export const followResolvers = {
  Query: {
    followers: (
      _parent: unknown,
      args: {
        username: string;
        first?: number | null;
        after?: string | null;
      },
      ctx: AppContext
    ) => listFollowers(requireUser(ctx).id, args.username, args.first, args.after),
    following: (
      _parent: unknown,
      args: {
        username: string;
        first?: number | null;
        after?: string | null;
      },
      ctx: AppContext
    ) => listFollowing(requireUser(ctx).id, args.username, args.first, args.after),
    followRequests: (
      _parent: unknown,
      args: { first?: number | null; after?: string | null },
      ctx: AppContext
    ) =>
      listFollowRequests(
        requireUser(ctx).id,
        args.first,
        args.after
      ),
  },

  Mutation: {
    follow: (
      _parent: unknown,
      args: { username: string },
      ctx: AppContext
    ) => followProfile(requireUser(ctx).id, args.username),
    unfollow: (
      _parent: unknown,
      args: { username: string },
      ctx: AppContext
    ) => unfollowProfile(requireUser(ctx).id, args.username),
    acceptFollowRequest: (
      _parent: unknown,
      args: { username: string },
      ctx: AppContext
    ) => acceptFollowRequest(requireUser(ctx).id, args.username),
    rejectFollowRequest: (
      _parent: unknown,
      args: { username: string },
      ctx: AppContext
    ) => rejectFollowRequest(requireUser(ctx).id, args.username),
    block: (
      _parent: unknown,
      args: { username: string },
      ctx: AppContext
    ) => blockProfile(requireUser(ctx).id, args.username),
    unblock: (
      _parent: unknown,
      args: { username: string },
      ctx: AppContext
    ) => unblockProfile(requireUser(ctx).id, args.username),
  },
};
