import * as webPush from "web-push";
import { prisma } from "../../config/db.js";
import { redis } from "../../config/redis.js";
import { env } from "../../config/env.js";
import { pushQueue } from "../../config/queues.js";
import { onMessageCreated } from "../chat/service.js";

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  icon: string;
  tag: string;
}

export type PushSender = (
  subscription: webPush.PushSubscription,
  payload: string
) => Promise<unknown>;

let pushSender: PushSender = async (subscription, payload) =>
  webPush.sendNotification(subscription, payload);

export function setPushSender(sender: PushSender): void {
  pushSender = sender;
}

export function getVapidPublicKey(): string {
  return env.vapidPublicKey;
}

export async function registerPushSubscription(
  userId: string,
  input: {
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string | null;
  }
) {
  const endpoint = input.endpoint.trim();
  if (!endpoint || !input.p256dh.trim() || !input.auth.trim()) {
    throw new Error("Invalid push subscription.");
  }
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: {
      userId,
      endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent?.trim() || null,
    },
    update: {
      userId,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent?.trim() || null,
      lastUsedAt: null,
    },
  });

  const excess = await prisma.pushSubscription.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (excess.length > 10) {
    await prisma.pushSubscription.deleteMany({
      where: { id: { in: excess.slice(0, excess.length - 10).map((item) => item.id) } },
    });
  }
  return true;
}

export async function unregisterPushSubscription(
  userId: string,
  endpoint: string
) {
  await prisma.pushSubscription.deleteMany({
    where: { userId, endpoint },
  });
  return true;
}

export async function sendToUser(
  userId: string,
  payload: PushPayload
): Promise<number> {
  const presence = await redis.exists(`presence:conn:${userId}`);
  if (presence > 0) return 0;

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId },
  });
  const body = JSON.stringify(payload);
  let sent = 0;
  for (const subscription of subscriptions) {
    try {
      await pushSender(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
        },
        body
      );
      sent += 1;
      await prisma.pushSubscription.update({
        where: { id: subscription.id },
        data: { lastUsedAt: new Date() },
      });
    } catch (error) {
      const statusCode =
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error
          ? Number((error as { statusCode?: unknown }).statusCode)
          : null;
      if (statusCode === 404 || statusCode === 410) {
        await prisma.pushSubscription.delete({
          where: { id: subscription.id },
        });
      }
    }
  }
  return sent;
}

export function queuePush(userId: string, payload: PushPayload): Promise<unknown> {
  return pushQueue.add("push:send", { userId, payload });
}

export function configurePush(): void {
  if (env.vapidPublicKey && env.vapidPrivateKey) {
    webPush.setVapidDetails(
      env.vapidSubject,
      env.vapidPublicKey,
      env.vapidPrivateKey
    );
  }
}

export function registerChatPushHook(): void {
  onMessageCreated.push(async (message) => {
    const sender = await prisma.profile.findUnique({
      where: { id: message.senderId },
      select: { username: true, avatarUrl: true },
    });
    if (!sender) return;
    const members = await prisma.conversationMember.findMany({
      where: { conversationId: message.conversationId },
      select: { userId: true },
    });
    const text = (message.body ?? "").trim();
    const body = text ? text.slice(0, 80) : "Sent a photo";
    for (const member of members) {
      if (member.userId === message.senderId) continue;
      await queuePush(member.userId, {
        title: sender.username,
        body: `${sender.username}: ${body}`,
        url: `/messages/${message.conversationId}`,
        icon: sender.avatarUrl ?? "",
        tag: `message:${message.conversationId}`,
      });
    }
  });
}
