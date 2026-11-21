import { Prisma, MemberRole, type Message } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { redis } from "../../config/redis.js";
import { badUserInput, forbidden, notFound } from "../../graphql/errors.js";
import { clampFirst, decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { describeOwnedMedia, type MediaType } from "../media/service.js";
import { getIO } from "../../realtime/io.js";

export interface SendMessageInput {
  conversationId: string;
  body?: string | null;
  media?: { publicId: string; type: MediaType } | null;
  clientId?: string | null;
}

type MessageCreatedHook = (message: Message) => void | Promise<void>;
export const onMessageCreated: MessageCreatedHook[] = [];

function unreadHash(userId: string): string {
  return `chat:unread:${userId}`;
}

async function ensureMember(conversationId: string, userId: string) {
  const member = await prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: { conversationId, userId },
    },
  });
  if (!member) throw forbidden("You are not a member of this conversation.");
  return member;
}

async function assertNoBlock(viewerId: string, targetId: string) {
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: viewerId, blockedId: targetId },
        { blockerId: targetId, blockedId: viewerId },
      ],
    },
  });
  if (block) throw forbidden("Blocked users cannot start or join conversations.");
}

export async function startConversation(
  viewerId: string,
  username: string
) {
  const target = await prisma.profile.findUnique({
    where: { username: username.trim().toLowerCase() },
  });
  if (!target) throw notFound("Profile not found.");
  if (target.id === viewerId) throw badUserInput("You cannot start a conversation with yourself.");
  await assertNoBlock(viewerId, target.id);

  const directKey = [viewerId, target.id].sort().join(":");
  const existing = await prisma.conversation.findUnique({
    where: { directKey },
  });
  if (existing) {
    await ensureMember(existing.id, viewerId);
    const members = await prisma.conversationMember.findMany({
      where: { conversationId: existing.id },
      select: { userId: true },
    });
    for (const member of members) {
      if (member.userId !== viewerId) {
        await assertNoBlock(viewerId, member.userId);
      }
    }
    return existing;
  }

  return prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: {
        isGroup: false,
        directKey,
        createdById: viewerId,
        members: {
          create: [
            { userId: viewerId, role: MemberRole.OWNER },
            { userId: target.id, role: MemberRole.MEMBER },
          ],
        },
      },
    });
    return conversation;
  });
}

export async function createGroup(
  viewerId: string,
  title: string,
  usernames: string[]
) {
  const trimmed = title.trim();
  if (trimmed.length < 1 || trimmed.length > 50) {
    throw badUserInput("Group title must be between 1 and 50 characters.");
  }
  if (usernames.length < 2 || usernames.length > 49) {
    throw badUserInput("A group needs between 2 and 49 other members.");
  }

  const normalized = [...new Set(usernames.map((name) => name.trim().toLowerCase()))];
  if (normalized.length !== usernames.length) {
    throw badUserInput("Group usernames must be unique.");
  }
  const profiles = await prisma.profile.findMany({
    where: { username: { in: normalized } },
  });
  if (profiles.length !== normalized.length) throw notFound("One or more profiles were not found.");

  for (const profile of profiles) {
    if (profile.id === viewerId) throw badUserInput("Do not include yourself in the usernames.");
    await assertNoBlock(viewerId, profile.id);
  }

  return prisma.$transaction(async (tx) => {
    return tx.conversation.create({
      data: {
        isGroup: true,
        title: trimmed,
        createdById: viewerId,
        members: {
          create: [
            { userId: viewerId, role: MemberRole.OWNER },
            ...profiles.map((profile) => ({
              userId: profile.id,
              role: MemberRole.MEMBER,
            })),
          ],
        },
      },
    });
  });
}

export async function sendMessage(
  senderId: string,
  input: SendMessageInput
): Promise<Message> {
  await ensureMember(input.conversationId, senderId);
  const membersBeforeSend = await prisma.conversationMember.findMany({
    where: { conversationId: input.conversationId },
    select: { userId: true },
  });
  for (const member of membersBeforeSend) {
    if (member.userId !== senderId) {
      await assertNoBlock(senderId, member.userId);
    }
  }
  const body = input.body?.trim() ?? "";
  if (body.length > 2000) {
    throw badUserInput("Message body must be at most 2000 characters.");
  }
  if (!body && !input.media) {
    throw badUserInput("A message needs a body or media.");
  }

  let mediaUrl: string | null = null;
  let mediaPublicId: string | null = null;
  if (input.media) {
    const media = await describeOwnedMedia(
      senderId,
      input.media,
      ["MESSAGE_IMAGE"]
    );
    mediaPublicId = media.publicId;
    mediaUrl = media.url;
  }

  if (input.clientId) {
    const existing = await prisma.message.findUnique({
      where: {
        conversationId_senderId_clientId: {
          conversationId: input.conversationId,
          senderId,
          clientId: input.clientId,
        },
      },
    });
    if (existing) return existing;
  }

  const saved = await prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        conversationId: input.conversationId,
        senderId,
        body: body || null,
        mediaPublicId,
        mediaUrl,
        clientId: input.clientId ?? null,
      },
    });
    await tx.conversation.update({
      where: { id: input.conversationId },
      data: { lastMessageAt: message.createdAt },
    });
    return message;
  });

  const members = await prisma.conversationMember.findMany({
    where: { conversationId: input.conversationId },
    select: { userId: true },
  });
  for (const member of members) {
    if (member.userId !== senderId) {
      await redis.hincrby(unreadHash(member.userId), input.conversationId, 1);
    }
  }

  const payload = serializeMessage(saved);
  const io = getIO();
  for (const member of members) {
    io.to(`user:${member.userId}`).emit("message:new", payload);
  }
  for (const hook of onMessageCreated) {
    await hook(saved);
  }
  return saved;
}

export async function markConversationRead(
  viewerId: string,
  conversationId: string
): Promise<boolean> {
  await ensureMember(conversationId, viewerId);
  const readAt = new Date();
  await prisma.conversationMember.update({
    where: {
      conversationId_userId: { conversationId, userId: viewerId },
    },
    data: { lastReadAt: readAt },
  });
  await redis.hdel(unreadHash(viewerId), conversationId);

  const io = getIO();
  const members = await prisma.conversationMember.findMany({
    where: { conversationId },
    select: { userId: true },
  });
  for (const member of members) {
    io.to(`user:${member.userId}`).emit("message:read", {
      conversationId,
      userId: viewerId,
      readAt: readAt.toISOString(),
    });
  }
  return true;
}

export async function deleteMessage(
  viewerId: string,
  messageId: string
): Promise<boolean> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
  });
  if (!message) throw notFound("Message not found.");
  if (message.senderId !== viewerId) {
    throw forbidden("Only the sender can delete this message.");
  }
  await ensureMember(message.conversationId, viewerId);
  const deleted = await prisma.message.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), body: null, mediaPublicId: null, mediaUrl: null },
  });
  const members = await prisma.conversationMember.findMany({
    where: { conversationId: deleted.conversationId },
    select: { userId: true },
  });
  const io = getIO();
  for (const member of members) {
    io.to(`user:${member.userId}`).emit("message:deleted", {
      conversationId: deleted.conversationId,
      messageId: deleted.id,
    });
  }
  return true;
}

async function recomputeUnread(
  conversationId: string,
  viewerId: string
): Promise<number> {
  const member = await prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: { conversationId, userId: viewerId },
    },
  });
  if (!member) return 0;
  const count = await prisma.message.count({
    where: {
      conversationId,
      senderId: { not: viewerId },
      ...(member.lastReadAt
        ? { createdAt: { gt: member.lastReadAt } }
        : {}),
      deletedAt: null,
    },
  });
  if (count > 0) {
    await redis.hset(unreadHash(viewerId), conversationId, count);
  } else {
    await redis.hdel(unreadHash(viewerId), conversationId);
  }
  return count;
}

export async function getUnreadCount(
  viewerId: string,
  conversationId: string
): Promise<number> {
  const value = await redis.hget(unreadHash(viewerId), conversationId);
  if (value !== null) return Math.max(Number(value), 0);
  return recomputeUnread(conversationId, viewerId);
}

export async function getConversations(
  viewerId: string,
  firstArg: number | null,
  after: string | null
) {
  const take = clampFirst(firstArg);
  const memberships = await prisma.conversationMember.findMany({
    where: { userId: viewerId },
  });
  const ids = memberships.map((membership) => membership.conversationId);
  if (ids.length === 0) return { items: [], nextCursor: null };

  const args: Prisma.ConversationFindManyArgs = {
    where: { id: { in: ids } },
    take: take + 1,
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
  };
  if (after) {
    args.cursor = { id: decodeCursor(after) };
    args.skip = 1;
  }
  const rows = await prisma.conversation.findMany(args);
  const hasNext = rows.length > take;
  const items = hasNext ? rows.slice(0, take) : rows;
  return {
    items,
    nextCursor: hasNext ? encodeCursor(items[items.length - 1].id) : null,
  };
}

export async function getConversation(viewerId: string, conversationId: string) {
  await ensureMember(conversationId, viewerId);
  return prisma.conversation.findUnique({ where: { id: conversationId } });
}

export async function getMessages(
  viewerId: string,
  conversationId: string,
  firstArg: number | null,
  after: string | null
) {
  await ensureMember(conversationId, viewerId);
  const take = clampFirst(firstArg);
  const args: Prisma.MessageFindManyArgs = {
    where: { conversationId },
    take: take + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  };
  if (after) {
    args.cursor = { id: decodeCursor(after) };
    args.skip = 1;
  }
  const rows = await prisma.message.findMany(args);
  const hasNext = rows.length > take;
  const items = hasNext ? rows.slice(0, take) : rows;
  return {
    items,
    nextCursor: hasNext ? encodeCursor(items[items.length - 1].id) : null,
  };
}

export function serializeMessage(message: Message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    body: message.deletedAt ? null : message.body,
    media: message.deletedAt
      ? null
      : message.mediaPublicId
        ? {
            publicId: message.mediaPublicId,
            url: message.mediaUrl,
            type: "IMAGE",
          }
        : null,
    createdAt: message.createdAt.toISOString(),
    deleted: message.deletedAt !== null,
    clientId: message.clientId,
  };
}
