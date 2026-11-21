import { Emitter } from "@socket.io/redis-emitter";
import { redis } from "../config/redis.js";

const emitterRedis = redis.duplicate();
emitterRedis.on("error", (error: Error) =>
  console.error("Socket.IO emitter Redis error:", error.message)
);
let localEmit:
  | ((room: string, event: string, payload: unknown) => void)
  | null = null;

export function registerLocalEmitter(
  handler: (room: string, event: string, payload: unknown) => void
): void {
  localEmit = handler;
}

export async function emitToUser(
  userId: string,
  event: string,
  payload: unknown
): Promise<void> {
  if (emitterRedis.status !== "ready") {
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        emitterRedis.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        emitterRedis.off("ready", onReady);
        reject(error);
      };
      emitterRedis.once("ready", onReady);
      emitterRedis.once("error", onError);
    });
  }
  const room = `user:${userId}`;
  const publications: Array<Promise<number>> = [];
  const publishingRedis = new Proxy(emitterRedis, {
    get(target, property, receiver) {
      if (property === "publish") {
        return (channel: string, message: string) => {
          const publication = target.publish(channel, message);
          publications.push(publication);
          return publication;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const emitter = new Emitter(publishingRedis);
  emitter.to(room).emit(event, payload);
  const subscriberCounts = await Promise.all(publications);
  if (subscriberCounts.some((count) => count === 0)) {
    console.warn(`No Socket.IO Redis adapter subscribed for event ${event}.`);
  }
  if (localEmit) localEmit(room, event, payload);
}
