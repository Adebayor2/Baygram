import { createHmac } from "node:crypto";

export interface TurnCredentials {
  username: string;
  credential: string;
}

export function createTurnCredentials(
  userId: string,
  secret: string,
  nowMs = Date.now()
): TurnCredentials {
  const username = `${Math.floor(nowMs / 1000) + 3600}:${userId}`;
  const credential = createHmac("sha1", secret)
    .update(username)
    .digest("base64");
  return { username, credential };
}
