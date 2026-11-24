import { describe, expect, it } from "vitest";
import { extractHashtags, extractMentions } from "../hashtags.js";

describe("hashtag and mention extraction", () => {
  it("normalizes, deduplicates, and supports Unicode hashtags", () => {
    expect(extractHashtags("#Bay #bay #caf\u00e9 #\u6771\u4eac #under_score #tag!"))
      .toEqual(["bay", "caf\u00e9", "\u6771\u4eac", "under_score", "tag"]);
  });

  it("requires a word boundary and ignores empty input", () => {
    expect(extractHashtags("inside#word and #valid")).toEqual(["valid"]);
    expect(extractHashtags(null)).toEqual([]);
    expect(extractHashtags("")).toEqual([]);
  });

  it("caps hashtag extraction at 30 unique names", () => {
    const text = Array.from({ length: 35 }, (_, index) => `#tag${index}`).join(" ");
    expect(extractHashtags(text)).toHaveLength(30);
  });

  it("extracts valid mentions once and rejects short, long, or embedded names", () => {
    expect(extractMentions("@Alice @alice mail@inline @ab @abcdefghijklmnopqrstu @bob_2"))
      .toEqual(["alice", "bob_2"]);
    expect(extractMentions(undefined)).toEqual([]);
  });

  it("caps mention extraction at 20 unique names", () => {
    const text = Array.from({ length: 25 }, (_, index) => `@user${index}`).join(" ");
    expect(extractMentions(text)).toHaveLength(20);
  });
});
