import { prisma } from "../../config/db.js";
import { env } from "../../config/env.js";
import {
  assertEqual,
  ensureProfiles,
  expectOk,
  gql,
  poll,
  resetData,
  redis,
  socketClient,
  step,
  type SmokeSocket,
} from "./helpers.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Ack {
  ok: boolean;
  callId?: string;
  code?: string;
}

export async function run(): Promise<void> {
  await resetData();
  await ensureProfiles();
  const alice = await socketClient("alice");
  const bob = await socketClient("bob");
  const carol = await socketClient("carol");

  try {
    let completedCallId = "";
    await step("invite, accept, relay offer answer and ICE", async () => {
      const incomingPromise = bob.once<{ callId: string; type: string }>("call:incoming");
      const aliceAck = await alice.emitAck<Ack>("call:invite", {
        toUsername: "bob",
        type: "VIDEO",
        ringTimeoutMs: 30000,
      });
      assertEqual(aliceAck.ok, true, "alice receives invite acknowledgement");
      if (!aliceAck.callId) throw new Error("Call id missing.");
      completedCallId = aliceAck.callId;
      const incoming = await incomingPromise;
      assertEqual(incoming.callId, completedCallId, "bob receives incoming call");

      const acceptedPromise = alice.once<{ callId: string }>("call:accepted");
      bob.socket.emit("call:accept", { callId: completedCallId });
      await acceptedPromise;

      const bobOffer = bob.once<{ callId: string; data: unknown }>("webrtc:offer");
      alice.socket.emit("webrtc:offer", { callId: completedCallId, data: { sdp: "alice-offer" } });
      const offer = await bobOffer;
      assertEqual(offer.data && isRecord(offer.data) ? offer.data.sdp : null, "alice-offer", "offer relayed unchanged");

      const aliceAnswer = alice.once<{ callId: string; data: unknown }>("webrtc:answer");
      bob.socket.emit("webrtc:answer", { callId: completedCallId, data: { sdp: "bob-answer" } });
      const answer = await aliceAnswer;
      assertEqual(answer.data && isRecord(answer.data) ? answer.data.sdp : null, "bob-answer", "answer relayed unchanged");

      const bobIce = bob.once<{ callId: string; data: unknown }>("webrtc:ice");
      alice.socket.emit("webrtc:ice", { callId: completedCallId, data: { candidate: "alice-ice" } });
      const ice = await bobIce;
      assertEqual(ice.data && isRecord(ice.data) ? ice.data.candidate : null, "alice-ice", "ICE relayed unchanged");

      let thirdReceived = false;
      bob.socket.once("webrtc:offer", () => {
        thirdReceived = true;
      });
      carol.socket.emit("webrtc:offer", { callId: completedCallId, data: { sdp: "carol-offer" } });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assertEqual(thirdReceived, false, "third participant is ignored");

      const aliceEnded = alice.once<{ durationSec: number }>("call:ended");
      const bobEnded = bob.once<{ durationSec: number }>("call:ended");
      alice.socket.emit("call:end", { callId: completedCallId });
      await Promise.all([aliceEnded, bobEnded]);
    });

    await step("completed call history", async () => {
      await poll("completed call log", async () =>
        (await prisma.callLog.findFirst({
          where: { status: "COMPLETED" },
        })) !== null
      );
      const log = await prisma.callLog.findFirst({
        where: { status: "COMPLETED" },
      });
      assertEqual(log?.status, "COMPLETED", "call log is completed");
      assertEqual((log?.durationSec ?? -1) >= 0, true, "duration is non-negative");

      const aliceHistory = await gql("alice", "{ callHistory { items { id status direction durationSec } } }");
      expectOk(aliceHistory);
      const bobHistory = await gql("bob", "{ callHistory { items { id status direction durationSec } } }");
      expectOk(bobHistory);
      assertEqual(
        JSON.stringify(aliceHistory.data?.callHistory).includes('"direction":"OUTGOING"'),
        true,
        "alice sees outgoing direction"
      );
      assertEqual(
        JSON.stringify(bobHistory.data?.callHistory).includes('"direction":"INCOMING"'),
        true,
        "bob sees incoming direction"
      );
    });

    await step("reject and cancel paths", async () => {
      const rejectIncoming = bob.once<{ callId: string }>("call:incoming");
      const aliceRejectInvite = await alice.emitAck<Ack>("call:invite", { toUsername: "bob", type: "AUDIO" });
      const rejectIncomingValue = await rejectIncoming;
      assertEqual(aliceRejectInvite.callId, rejectIncomingValue.callId, "reject call id");
      const rejectedPromise = alice.once<{ callId: string }>("call:rejected");
      bob.socket.emit("call:reject", { callId: rejectIncomingValue.callId });
      await rejectedPromise;
      await poll("rejected call log", async () =>
        (await prisma.callLog.findFirst({
          where: { status: "REJECTED" },
        })) !== null
      );

      const cancelIncoming = bob.once<{ callId: string }>("call:incoming");
      const aliceCancelInvite = await alice.emitAck<Ack>("call:invite", { toUsername: "bob", type: "AUDIO" });
      const cancelIncomingValue = await cancelIncoming;
      const canceled = bob.once<{ callId: string }>("call:canceled");
      alice.socket.emit("call:cancel", { callId: aliceCancelInvite.callId });
      await canceled;
      await poll("canceled call log", async () =>
        (await prisma.callLog.findFirst({ where: { status: "CANCELED" } })) !== null
      );
    });

    await step("busy, blocked, and self failures", async () => {
      const bobIncoming = bob.once<{ callId: string }>("call:incoming");
      const aliceBusyInvite = await alice.emitAck<Ack>("call:invite", { toUsername: "bob", type: "AUDIO" });
      await bobIncoming;
      bob.socket.emit("call:accept", { callId: aliceBusyInvite.callId });

      const carolBusy = carol.emitAck<Ack>("call:invite", { toUsername: "bob", type: "AUDIO" });
      const carolBusyAck = await carolBusy;
      assertEqual(carolBusyAck.code, "BUSY", "busy user gets BUSY");

      const block = await gql("alice", "mutation { block(username: \"carol\") { id } }");
      expectOk(block);
      const blocked = await alice.emitAck<Ack>("call:invite", { toUsername: "carol", type: "AUDIO" });
      assertEqual(blocked.code, "FORBIDDEN", "blocked call is forbidden");
      const self = await alice.emitAck<Ack>("call:invite", { toUsername: "alice", type: "AUDIO" });
      assertEqual(self.code, "FORBIDDEN", "calling self is forbidden");

      alice.socket.emit("call:end", { callId: aliceBusyInvite.callId });
      const aliceProfile = await prisma.profile.findUnique({ where: { username: "alice" } });
      const bobProfile = await prisma.profile.findUnique({ where: { username: "bob" } });
      await poll("busy call state cleared", async () =>
        (!aliceProfile || (await redis.exists(`call:active:${aliceProfile.id}`)) === 0) &&
        (!bobProfile || (await redis.exists(`call:active:${bobProfile.id}`)) === 0)
      );
    });

    await step("ring timeout creates missed call", async () => {
      const bobMissed = bob.once<{ callId: string }>("call:missed");
      const aliceMissed = alice.once<{ callId: string }>("call:missed");
      const timeoutAck = await alice.emitAck<Ack>("call:invite", {
        toUsername: "bob",
        type: "AUDIO",
        ringTimeoutMs: 3000,
      });
      assertEqual(timeoutAck.ok, true, "timeout call invitation is accepted");
      if (!timeoutAck.callId) throw new Error("Timeout call id missing.");
      await Promise.all([bobMissed, aliceMissed]);
      await poll("missed call notification", async () => {
        const bobNotifications = await gql(
          "bob",
          "{ notifications(unreadOnly: true) { items { type } } }"
        );
        return JSON.stringify(bobNotifications.data).includes("MISSED_CALL");
      });
      await poll("missed call log", async () =>
        (await prisma.callLog.findFirst({ where: { status: "MISSED" } })) !== null
      );
    });

    await step("ice servers include STUN and optional TURN", async () => {
      const result = await gql("alice", "{ iceServers { urls username credential } }");
      expectOk(result);
      const text = JSON.stringify(result.data?.iceServers);
      assertEqual(text.includes("stun:"), true, "STUN server is returned");
      if (env.turnUrl && env.turnSecret) {
        assertEqual(/\\d+:[^"]+/.test(text), true, "TURN username is timestamp:userId");
      }
    });
  } finally {
    await Promise.all([alice.close(), bob.close(), carol.close()]);
  }
}
