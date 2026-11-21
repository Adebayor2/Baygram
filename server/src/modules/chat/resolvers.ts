import { requireUser } from "../../auth/requireUser.js";
import type { AppContext } from "../../graphql/context.js";
import { badUserInput } from "../../graphql/errors.js";
import {
  createGroup,
  deleteMessage,
  getConversation,
  getConversations,
  getMessages,
  getUnreadCount,
  markConversationRead,
  sendMessage,
  startConversation,
  type SendMessageInput,
} from "./service.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const chatResolvers = {
  Query: {
    conversations: async (
      _parent: unknown,
      args: { first?: number | null; after?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getConversations(user.id, args.first ?? null, args.after ?? null);
    },
    conversation: async (
      _parent: unknown,
      args: { id: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getConversation(user.id, args.id);
    },
    messages: async (
      _parent: unknown,
      args: { conversationId: string; first?: number | null; after?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getMessages(
        user.id,
        args.conversationId,
        args.first ?? null,
        args.after ?? null
      );
    },
  },
  Mutation: {
    startConversation: async (
      _parent: unknown,
      args: { username: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return startConversation(user.id, args.username);
    },
    createGroup: async (
      _parent: unknown,
      args: { title: string; usernames: string[] },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return createGroup(user.id, args.title, args.usernames);
    },
    sendMessage: async (
      _parent: unknown,
      args: { input: SendMessageInput },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      if (!isRecord(args) || !("input" in args)) {
        throw badUserInput("SendMessageInput is required.");
      }
      return sendMessage(user.id, args.input);
    },
    markConversationRead: async (
      _parent: unknown,
      args: { conversationId: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return markConversationRead(user.id, args.conversationId);
    },
    deleteMessage: async (
      _parent: unknown,
      args: { messageId: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return deleteMessage(user.id, args.messageId);
    },
  },
  Conversation: {
    members: async (
      conversation: { id: string },
      _args: unknown,
      ctx: AppContext
    ) => {
      const members = await ctx.prisma.conversationMember.findMany({
        where: { conversationId: conversation.id },
        include: { profile: true },
        orderBy: { joinedAt: "asc" },
      });
      return members.map((member) => member.profile);
    },
    lastMessage: async (
      conversation: { id: string }
    ) => prismaLastMessage(conversation.id),
    unreadCount: async (
      conversation: { id: string },
      _args: unknown,
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getUnreadCount(user.id, conversation.id);
    },
    lastMessageAt: (conversation: { lastMessageAt: Date }) =>
      conversation.lastMessageAt.toISOString(),
  },
  Message: {
    sender: (
      message: { senderId: string },
      _args: unknown,
      ctx: AppContext
    ) => ctx.loaders.author.load(message.senderId),
    media: (message: {
      deletedAt: Date | null;
      mediaPublicId: string | null;
      mediaUrl: string | null;
    }) => {
      if (message.deletedAt || !message.mediaPublicId) return null;
      return {
        publicId: message.mediaPublicId,
        url: message.mediaUrl,
        type: "IMAGE",
        width: null,
        height: null,
        durationSec: null,
      };
    },
    deleted: (message: { deletedAt: Date | null }) =>
      message.deletedAt !== null,
    body: (message: { deletedAt: Date | null; body: string | null }) =>
      message.deletedAt ? null : message.body,
    createdAt: (message: { createdAt: Date }) =>
      message.createdAt.toISOString(),
  },
};

async function prismaLastMessage(conversationId: string) {
  const { prisma } = await import("../../config/db.js");
  return prisma.message.findFirst({
    where: { conversationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}
