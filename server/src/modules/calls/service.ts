import { createHmac, randomUUID } from "node:crypto";
import { CallStatus, Prisma } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { redis } from "../../config/redis.js";
import { env } from "../../config/env.js";
import { callsQueue } from "../../config/queues.js";
import { forbidden, notFound } from "../../graphql/errors.js";
import { badUserInput } from "../../graphql/errors.js";
import { clampFirst, decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { emitToUser } from "../../realtime/emit.js";
import { notifyUser } from "../notifications/service.js";

interface CallState {
  callerId: string;
  calleeId: string;
  type: "AUDIO" | "VIDEO";
  status: "RINGING" | "ACTIVE";
  startedAt: string;
  answeredAt: string;
}

async function getCall(callId: string): Promise<CallState | null> {
  const value = await redis.hgetall(`call:${callId}`);
  if (!value.callerId || !value.calleeId) return null;
  return {
    callerId: value.callerId,
    calleeId: value.calleeId,
    type: value.type as "AUDIO" | "VIDEO",
    status: value.status as "RINGING" | "ACTIVE",
    startedAt: value.startedAt,
    answeredAt: value.answeredAt ?? "",
  };
}

async function removeCallJob(callId: string): Promise<void> {
  const jobs = await callsQueue.getJobs([
    "waiting",
    "delayed",
    "active",
    "prioritized",
  ]);
  for (const job of jobs) {
    if (job.data?.callId !== callId) continue;
    if ((await job.getState()) === "active") continue;
    await job.remove();
  }
}

async function clearCall(callId: string, callerId: string, calleeId: string) {
  await redis.del(`call:${callId}`);
  await redis.del(`call:active:${callerId}`);
  await redis.del(`call:active:${calleeId}`);
  await removeCallJob(callId);
}

async function writeCallLog(
  state: CallState,
  status: CallStatus,
  options: { endedAt?: Date; durationSec?: number | null } = {}
) {
  const startedAt = new Date(state.startedAt);
  const answeredAt = state.answeredAt ? new Date(state.answeredAt) : null;
  await prisma.callLog.create({
    data: {
      callerId: state.callerId,
      calleeId: state.calleeId,
      type: state.type,
      status,
      startedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
      answeredAt,
      endedAt: options.endedAt ?? null,
      durationSec: options.durationSec ?? null,
    },
  });
}

export async function inviteCall(
  callerId: string,
  toUsername: string,
  type: "AUDIO" | "VIDEO",
  ringTimeoutMs = 30000
) {
  const callee = await prisma.profile.findUnique({
    where: { username: toUsername.trim().toLowerCase() },
  });
  if (!callee) throw notFound("User not found.");
  if (callee.id === callerId) throw forbidden("Cannot call yourself.");

  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: callerId, blockedId: callee.id },
        { blockerId: callee.id, blockedId: callerId },
      ],
    },
  });
  if (block) throw forbidden("Calls are not allowed.");

  if ((await redis.exists(`call:active:${callerId}`)) > 0) {
    throw forbidden("ALREADY_IN_CALL");
  }
  if ((await redis.exists(`call:active:${callee.id}`)) > 0) {
    throw forbidden("BUSY");
  }

  const minute = Math.floor(Date.now() / 60000);
  const key = `rl:call:${callerId}:${minute}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  if (count > 5) throw forbidden("RATE_LIMITED");

  const callId = randomUUID();
  const startedAt = new Date().toISOString();
  await redis
    .multi()
    .hmset(
      `call:${callId}`,
      "callerId",
      callerId,
      "calleeId",
      callee.id,
      "type",
      type,
      "status",
      "RINGING",
      "startedAt",
      startedAt
    )
    .expire(`call:${callId}`, 7200)
    .set(`call:active:${callerId}`, callId, "EX", 7200, "NX")
    .set(`call:active:${callee.id}`, callId, "EX", 7200, "NX")
    .exec();

  const delay = Math.min(
    Math.max(Number(ringTimeoutMs) || 30000, 100),
    30000
  );
  await callsQueue.add(
    "call:ring",
    { callId },
    { jobId: callId, delay }
  );
  if (env.nodeEnv !== "production") {
    const fallback = setTimeout(() => {
      void processCallRingTimeout(callId);
    }, delay + 100);
    fallback.unref();
  }
  const caller = await prisma.profile.findUnique({
    where: { id: callerId },
    select: { username: true, avatarUrl: true },
  });
  await emitToUser(callee.id, "call:incoming", {
    callId,
    from: {
      id: callerId,
      username: caller?.username ?? "",
      avatarUrl: caller?.avatarUrl ?? null,
    },
    type,
  });
  return callId;
}

export async function acceptCall(userId: string, callId: string) {
  const state = await getCall(callId);
  if (!state || state.calleeId !== userId) return false;
  if (state.status !== "RINGING") return false;
  const answeredAt = new Date().toISOString();
  await redis.hset(`call:${callId}`, "status", "ACTIVE", "answeredAt", answeredAt);
  await redis.expire(`call:${callId}`, 7200);
  await removeCallJob(callId);
  await emitToUser(state.callerId, "call:accepted", { callId });
  return true;
}

export async function rejectCall(userId: string, callId: string) {
  const state = await getCall(callId);
  if (!state || state.calleeId !== userId) return false;
  await writeCallLog(state, CallStatus.REJECTED, { endedAt: new Date() });
  await clearCall(callId, state.callerId, state.calleeId);
  await emitToUser(state.callerId, "call:rejected", { callId });
  return true;
}

export async function cancelCall(userId: string, callId: string) {
  const state = await getCall(callId);
  if (!state || state.callerId !== userId) return false;
  await writeCallLog(state, CallStatus.CANCELED, { endedAt: new Date() });
  await clearCall(callId, state.callerId, state.calleeId);
  await emitToUser(state.calleeId, "call:canceled", { callId });
  return true;
}

export async function endCall(userId: string, callId: string) {
  const state = await getCall(callId);
  if (!state || (state.callerId !== userId && state.calleeId !== userId)) return false;
  const endedAt = new Date();
  const base = state.answeredAt ? new Date(state.answeredAt).getTime() : new Date(state.startedAt).getTime();
  const durationSec = Math.max(0, Math.floor((endedAt.getTime() - base) / 1000));
  await writeCallLog(state, CallStatus.COMPLETED, { endedAt, durationSec });
  await clearCall(callId, state.callerId, state.calleeId);
  await emitToUser(state.callerId, "call:ended", { callId, durationSec, reason: "ended" });
  await emitToUser(state.calleeId, "call:ended", { callId, durationSec, reason: "ended" });
  return true;
}

export async function relayWebRtc(
  userId: string,
  callId: string,
  event: "webrtc:offer" | "webrtc:answer" | "webrtc:ice",
  data: unknown
) {
  const state = await getCall(callId);
  if (!state) return false;
  if (state.status !== "ACTIVE") return false;
  if (state.callerId !== userId && state.calleeId !== userId) return false;
  const recipient = state.callerId === userId ? state.calleeId : state.callerId;
  await emitToUser(recipient, event, { callId, data });
  return true;
}

export async function processCallRingTimeout(callId: string) {
  const state = await getCall(callId);
  if (!state || state.status !== "RINGING") return;
  const claimed = await redis.eval(
    `if redis.call('HGET', KEYS[1], 'status') == 'RINGING' then
       redis.call('HSET', KEYS[1], 'status', 'MISSED')
       return 1
     end
     return 0`,
    1,
    `call:${callId}`
  );
  if (Number(claimed) !== 1) return;
  const endedAt = new Date();
  await writeCallLog(state, CallStatus.MISSED, { endedAt });
  await clearCall(callId, state.callerId, state.calleeId);
  await emitToUser(state.callerId, "call:missed", { callId });
  await emitToUser(state.calleeId, "call:missed", { callId });
  await notifyUser({
    type: "MISSED_CALL",
    recipientId: state.calleeId,
    actorId: state.callerId,
  });
}

export async function processCallDisconnect(callId: string, userId: string) {
  const state = await getCall(callId);
  if (!state || state.status !== "ACTIVE") return;
  if (state.callerId !== userId && state.calleeId !== userId) return;
  if ((await redis.exists(`presence:conn:${userId}`)) > 0) return;
  const endedAt = new Date();
  const base = state.answeredAt ? new Date(state.answeredAt).getTime() : new Date(state.startedAt).getTime();
  const durationSec = Math.max(0, Math.floor((endedAt.getTime() - base) / 1000));
  await writeCallLog(state, CallStatus.COMPLETED, { endedAt, durationSec });
  await clearCall(callId, state.callerId, state.calleeId);
  await emitToUser(state.callerId, "call:ended", { callId, durationSec, reason: "disconnected" });
  await emitToUser(state.calleeId, "call:ended", { callId, durationSec, reason: "disconnected" });
}

export async function enqueueDisconnectCheck(callId: string, userId: string) {
  await callsQueue.add(
    "call:disconnect",
    { callId, userId },
    { jobId: `disconnect:${callId}:${userId}`, delay: 10000 }
  );
}

export async function failCallAck(code: string): Promise<{ ok: false; code: string }> {
  return { ok: false, code };
}

export async function getCallHistory(
  viewerId: string,
  firstArg: number | null,
  after: string | null
) {
  const take = clampFirst(firstArg);
  let cursorId: string | null = null;
  if (after) {
    try {
      cursorId = decodeCursor(after);
    } catch {
      throw badUserInput("Invalid cursor.");
    }
  }
  const args: Prisma.CallLogFindManyArgs = {
    where: { OR: [{ callerId: viewerId }, { calleeId: viewerId }] },
    include: { caller: true, callee: true },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: take + 1,
  };
  if (cursorId) {
    args.cursor = { id: cursorId };
    args.skip = 1;
  }
  const rows = await prisma.callLog.findMany(args);
  const hasNext = rows.length > take;
  const items = hasNext ? rows.slice(0, take) : rows;
  return {
    items: items.map((item) => ({
      ...item,
      direction: item.callerId === viewerId ? "OUTGOING" : "INCOMING",
    })),
    nextCursor: hasNext ? encodeCursor(items[items.length - 1].id) : null,
  };
}

export function getIceServers(userId: string) {
  const stun = { urls: [env.stunUrl], username: null, credential: null };
  if (!env.turnUrl || !env.turnSecret) return [stun];
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const username = `${expiry}:${userId}`;
  const credential = createHmac("sha1", env.turnSecret)
    .update(username)
    .digest("base64");
  return [
    stun,
    { urls: env.turnUrl.split(",").map((value) => value.trim()).filter(Boolean), username, credential },
  ];
}
