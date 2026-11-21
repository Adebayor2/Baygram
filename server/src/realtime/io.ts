import type http from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { verifyToken } from "../auth/getUser.js";
import { connectPresence, disconnectPresence } from "./presence.js";
import { prisma } from "../config/db.js";
import {
  sendMessage,
  markConversationRead,
  serializeMessage,
  type SendMessageInput,
} from "../modules/chat/service.js";
import { registerLocalEmitter } from "./emit.js";

let io: SocketIOServer | null = null;

function allowedOrigins(): string[] | true {
  if (env.clientOrigin.trim() === "*") return true;
  return env.clientOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function initIO(httpServer: http.Server): SocketIOServer {
  if (io) return io;

  io = new SocketIOServer(httpServer, {
    cors: {
      origin: allowedOrigins(),
      credentials: true,
    },
  });
  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();
  pubClient.on("error", (error: Error) =>
    console.error("Socket.IO Redis publisher error:", error.message)
  );
  subClient.on("error", (error: Error) =>
    console.error("Socket.IO Redis subscriber error:", error.message)
  );
  io.adapter(createAdapter(pubClient, subClient));
  registerLocalEmitter((room, event, payload) => {
    io?.to(room).emit(event, payload);
  });
  console.log(`Socket.IO Redis adapter attached: ${io.of("/").adapter.constructor.name}`);

  io.use(async (socket, next) => {
    const token =
      typeof socket.handshake.auth.token === "string"
        ? socket.handshake.auth.token
        : null;
    if (!token) return next(new Error("UNAUTHENTICATED"));
    try {
      const user = await verifyToken(token);
      if (!user) return next(new Error("UNAUTHENTICATED"));
      socket.data.userId = user.id;
      socket.data.exp = user.exp;
      return next();
    } catch {
      return next(new Error("UNAUTHENTICATED"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    void connectPresence(userId);
    const joined = socket.join(`user:${userId}`);
    void Promise.resolve(joined)
      .then(() => socket.emit("ready", { userId, instance: env.instanceId }))
      .catch((error: unknown) => {
        console.error(
          "Could not join the user's Socket.IO room:",
          error instanceof Error ? error.message : String(error)
        );
        socket.disconnect(true);
      });

    socket.on("ping:test", (payload: unknown, acknowledgement?: (value: unknown) => void) => {
      void payload;
      if (typeof acknowledgement === "function") {
        acknowledgement({ pong: true, instance: env.instanceId });
      }
    });

    socket.on(
      "message:send",
      async (
        input: SendMessageInput,
        acknowledgement?: (value: unknown) => void
      ) => {
        try {
          const message = await sendMessage(userId, input);
          if (typeof acknowledgement === "function") {
            acknowledgement({ ok: true, message: serializeMessage(message) });
          }
        } catch (error) {
          const code =
            error && typeof error === "object" && "extensions" in error
              ? ((error as { extensions?: { code?: string } }).extensions?.code ??
                "BAD_USER_INPUT")
              : "BAD_USER_INPUT";
          if (typeof acknowledgement === "function") {
            acknowledgement({ ok: false, code });
          }
        }
      }
    );

    socket.on(
      "conversation:read",
      async (payload: { conversationId?: string }) => {
        if (!payload?.conversationId) return;
        await markConversationRead(userId, payload.conversationId);
      }
    );

    for (const eventName of ["typing:start", "typing:stop"] as const) {
      socket.on(eventName, async (payload: { conversationId?: string }) => {
        if (!payload?.conversationId) return;
        const member = await prisma.conversationMember.findUnique({
          where: {
            conversationId_userId: {
              conversationId: payload.conversationId,
              userId,
            },
          },
        });
        if (!member) return;
        const members = await prisma.conversationMember.findMany({
          where: { conversationId: payload.conversationId },
          select: { userId: true },
        });
        for (const memberRow of members) {
          if (memberRow.userId === userId) continue;
          io?.to(`user:${memberRow.userId}`).emit("typing", {
            conversationId: payload.conversationId,
            userId,
            isTyping: eventName === "typing:start",
          });
        }
      });
    }

    const heartbeat = setInterval(() => {
      void redis.expire(`presence:conn:${userId}`, 90);
    }, 30_000);

    let expiryTimer: NodeJS.Timeout | null = null;
    const exp = socket.data.exp as number | null;
    if (exp) {
      const delay = exp * 1000 - Date.now();
      if (delay <= 0) {
        socket.disconnect(true);
      } else {
        expiryTimer = setTimeout(() => socket.disconnect(true), delay);
      }
    }

    socket.on("disconnect", () => {
      clearInterval(heartbeat);
      if (expiryTimer) clearTimeout(expiryTimer);
      void disconnectPresence(userId);
    });
  });

  return io;
}

export function getIO(): SocketIOServer {
  if (!io) throw new Error("Socket.IO has not been initialized.");
  return io;
}
