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
import { rateLimit } from "../lib/rateLimit.js";
import {
  acceptCall,
  cancelCall,
  enqueueDisconnectCheck,
  endCall,
  inviteCall,
  rejectCall,
  relayWebRtc,
} from "../modules/calls/service.js";

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
      "call:invite",
      async (
        payload: { toUsername?: string; type?: "AUDIO" | "VIDEO"; ringTimeoutMs?: number },
        acknowledgement?: (value: unknown) => void
      ) => {
        try {
          if (!payload?.toUsername || (payload.type !== "AUDIO" && payload.type !== "VIDEO")) {
            if (acknowledgement) acknowledgement({ ok: false, code: "BAD_USER_INPUT" });
            return;
          }
          const callId = await inviteCall(userId, payload.toUsername, payload.type, payload.ringTimeoutMs);
          if (acknowledgement) acknowledgement({ ok: true, callId });
        } catch (error) {
          const message =
            error && typeof error === "object" && "message" in error
              ? String((error as { message: unknown }).message)
              : "";
          let code = "BAD_USER_INPUT";
          if (message === "User not found.") code = "NOT_FOUND";
          else if (["BUSY", "ALREADY_IN_CALL", "RATE_LIMITED"].includes(message)) code = message;
          else if (message === "Cannot call yourself." || message === "Calls are not allowed.") code = "FORBIDDEN";
          if (acknowledgement) acknowledgement({ ok: false, code });
          io?.to(`user:${userId}`).emit("call:failed", { code });
        }
      }
    );

    socket.on("call:accept", (payload: { callId?: string }) => {
      if (payload?.callId) void acceptCall(userId, payload.callId);
    });
    socket.on("call:reject", (payload: { callId?: string }) => {
      if (payload?.callId) void rejectCall(userId, payload.callId);
    });
    socket.on("call:cancel", (payload: { callId?: string }) => {
      if (payload?.callId) void cancelCall(userId, payload.callId);
    });
    socket.on("call:end", (payload: { callId?: string }) => {
      if (payload?.callId) void endCall(userId, payload.callId);
    });
    for (const eventName of ["webrtc:offer", "webrtc:answer", "webrtc:ice"] as const) {
      socket.on(eventName, (payload: { callId?: string; data?: unknown }) => {
        if (payload?.callId) {
          void relayWebRtc(userId, payload.callId, eventName, payload.data);
        }
      });
    }

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
        try {
          await rateLimit({
            scope: "typing",
            id: userId,
            limit: 10,
            windowSec: 5,
          });
        } catch {
          return;
        }
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
      void (async () => {
        await disconnectPresence(userId);
        if (!(await redis.exists(`presence:conn:${userId}`))) {
          let cursor = "0";
          do {
            const [next, keys] = await redis.scan(
              cursor,
              "MATCH",
              "call:*",
              "COUNT",
              100
            );
            cursor = next;
            for (const key of keys) {
              if (!key.startsWith("call:")) continue;
              const callId = key.slice("call:".length);
              if (!callId || callId.startsWith("active:")) continue;
              const callerId = await redis.hget(key, "callerId");
              const calleeId = await redis.hget(key, "calleeId");
              const status = await redis.hget(key, "status");
              if (
                status === "ACTIVE" &&
                (callerId === userId || calleeId === userId)
              ) {
                await enqueueDisconnectCheck(callId, userId);
              }
            }
          } while (cursor !== "0");
        }
      })();
    });
  });

  return io;
}

export function getIO(): SocketIOServer {
  if (!io) throw new Error("Socket.IO has not been initialized.");
  return io;
}
