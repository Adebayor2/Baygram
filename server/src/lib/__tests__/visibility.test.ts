import { describe, expect, it } from "vitest";
import { decideVisibility } from "../visibility.js";

const ownerId = "owner";
const viewerId = "viewer";

describe("decideVisibility", () => {
  it.each([
    ["public owner can view own content", viewerId, false, false, false, true],
    ["private owner can view own content", ownerId, true, false, true, true],
    ["public content is visible to a logged-in viewer", "other", false, false, false, true],
    ["public content is visible despite a pending follow", "other", false, false, false, true],
    ["private content is visible to an accepted follower", "other", true, true, false, true],
    ["private content is hidden without a follow", "other", true, false, false, false],
    ["private content is hidden for a pending follow", "other", true, false, false, false],
    ["public content is hidden when viewer blocks owner", "other", false, true, true, false],
    ["public content is hidden when owner blocks viewer", "other", false, false, true, false],
    ["private content remains hidden when viewer blocks owner", "other", true, true, true, false],
    ["anonymous viewer cannot see public content", null, false, false, false, false],
    ["anonymous viewer cannot see private content", null, true, true, false, false],
  ] as const)("%s", (_label, viewer, isPrivate, accepted, blocked, expected) => {
    expect(
      decideVisibility({
        viewerId: viewer === "other" ? viewerId : viewer,
        ownerId,
        ownerIsPrivate: isPrivate,
        isAcceptedFollower: accepted,
        blockedEitherWay: blocked,
      })
    ).toBe(expected);
  });
});
