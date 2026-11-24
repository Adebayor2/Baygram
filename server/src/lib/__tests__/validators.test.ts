import { describe, expect, it } from "vitest";
import {
  createPostInputSchema,
  createProfileInputSchema,
  updateProfileInputSchema,
  usernameSchema,
} from "../validators.js";

describe("input validation", () => {
  it("normalizes valid usernames", () => {
    expect(usernameSchema.parse("  Alice_7  ")).toBe("alice_7");
  });

  it.each(["ab", "this_username_is_far_too_long", "two words", "admin", "a-b"]) (
    "rejects invalid or reserved username %j",
    (username) => {
      expect(usernameSchema.safeParse(username).success).toBe(false);
    }
  );

  it("validates profile limits and requires an update field", () => {
    expect(createProfileInputSchema.safeParse({ username: "alice", fullName: "A".repeat(50) }).success).toBe(true);
    expect(createProfileInputSchema.safeParse({ username: "alice", fullName: "A".repeat(51) }).success).toBe(false);
    expect(updateProfileInputSchema.safeParse({}).success).toBe(false);
    expect(updateProfileInputSchema.safeParse({ bio: "B".repeat(151) }).success).toBe(false);
    expect(updateProfileInputSchema.safeParse({ isPrivate: false }).success).toBe(true);
  });

  it("validates post media counts, types, and captions", () => {
    const valid = { caption: "hello", media: [{ publicId: "social/user/post_image/asset", type: "IMAGE" }] };
    expect(createPostInputSchema.safeParse(valid).success).toBe(true);
    expect(createPostInputSchema.safeParse({ ...valid, media: [] }).success).toBe(false);
    expect(createPostInputSchema.safeParse({ ...valid, media: Array.from({ length: 11 }, () => valid.media[0]) }).success).toBe(false);
    expect(createPostInputSchema.safeParse({ ...valid, caption: "x".repeat(2201) }).success).toBe(false);
  });
});
