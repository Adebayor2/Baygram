import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTurnCredentials } from "../turn.js";

describe("TURN credentials", () => {
  it("uses an expiring user-prefixed username and an HMAC-SHA1 credential", () => {
    const userId = "user-123";
    const secret = "known-test-secret";
    const nowMs = 1_700_000_000_000;
    const expiry = 1_700_003_600;
    const username = `${expiry}:${userId}`;
    const expectedCredential = createHmac("sha1", secret)
      .update(username)
      .digest("base64");

    expect(createTurnCredentials(userId, secret, nowMs)).toEqual({
      username,
      credential: expectedCredential,
    });
  });
});
