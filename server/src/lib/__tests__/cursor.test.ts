import { describe, expect, it } from "vitest";
import { GraphQLError } from "graphql";
import { decodeCursor, encodeCursor } from "../cursor.js";

describe("cursor encoding", () => {
  it("round-trips ids using URL-safe base64", () => {
    const id = "c742c36b-4a1a-4fd7-bcc3-4a0cf9b704f6";
    const cursor = encodeCursor(id);

    expect(cursor).not.toMatch(/[=+/]/);
    expect(decodeCursor(cursor)).toBe(id);
  });

  it.each(["", "!!!", "YQ=", "AA", "_w"]) (
    "rejects malformed cursor %j as BAD_USER_INPUT",
    (cursor) => {
      try {
        decodeCursor(cursor);
        throw new Error("Expected decodeCursor to reject the cursor.");
      } catch (error) {
        expect(error).toBeInstanceOf(GraphQLError);
        expect((error as GraphQLError).extensions.code).toBe("BAD_USER_INPUT");
      }
    }
  );
});
