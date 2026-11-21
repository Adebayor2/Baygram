import { requireUser } from "../../auth/requireUser.js";
import type { AppContext } from "../../graphql/context.js";
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationsCount,
} from "./service.js";

export const notificationResolvers = {
  Query: {
    notifications: async (
      _parent: unknown,
      args: { first?: number | null; after?: string | null; unreadOnly?: boolean },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getNotifications(
        user.id,
        args.first ?? null,
        args.after ?? null,
        args.unreadOnly ?? false
      );
    },
    unreadNotificationsCount: async (
      _parent: unknown,
      _args: unknown,
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return unreadNotificationsCount(user.id);
    },
  },
  Mutation: {
    markNotificationRead: async (
      _parent: unknown,
      args: { id: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return markNotificationRead(user.id, args.id);
    },
    markAllNotificationsRead: async (
      _parent: unknown,
      _args: unknown,
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return markAllNotificationsRead(user.id);
    },
  },
  Notification: {
    actor: (
      notification: { actorId: string },
      _args: unknown,
      ctx: AppContext
    ) => ctx.loaders.author.load(notification.actorId),
    post: (
      notification: { postId: string | null },
      _args: unknown,
      ctx: AppContext
    ) => notification.postId
      ? ctx.prisma.post.findUnique({
          where: { id: notification.postId },
          include: { media: { orderBy: { position: "asc" } } },
        })
      : null,
    comment: (
      notification: { commentId: string | null },
      _args: unknown,
      ctx: AppContext
    ) => notification.commentId
      ? ctx.prisma.comment.findUnique({ where: { id: notification.commentId } })
      : null,
    readAt: (notification: { readAt: Date | null }) =>
      notification.readAt?.toISOString() ?? null,
    createdAt: (notification: { createdAt: Date }) =>
      notification.createdAt.toISOString(),
  },
};
