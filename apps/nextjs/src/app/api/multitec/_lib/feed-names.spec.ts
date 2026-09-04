import { describe, expect, test } from "vitest";

import { isMemberFeed, isServableAsShared, isValidFeedName, MEMBER_FEED_PREFIX } from "./feed-names";

describe("feed names", () => {
  test("accepts the names the publisher actually uses", () => {
    for (const name of ["quantumpc", "claude-seats", "drive-latest", "member-billing", "a", "a1", "x".repeat(64)]) {
      expect(isValidFeedName(name), name).toBe(true);
    }
  });

  test("refuses anything that is not a name", () => {
    for (const name of [
      "",
      "-leading-dash",
      "Upper",
      "with space",
      "with_underscore",
      "with.dot",
      "../secrets",
      "..%2fsecrets",
      "a/b",
      "x".repeat(65),
      "member-billing\n",
      "névoa",
    ]) {
      expect(isValidFeedName(name), JSON.stringify(name)).toBe(false);
    }
  });

  // The single line that stands between one member and everybody else's rows. A
  // `member-*` feed holds the whole association keyed by email and the shared path applies
  // no filter, so it must be refused there — not merely discouraged by a convention.
  test("a member feed is never servable on the shared path", () => {
    expect(isMemberFeed("member-billing")).toBe(true);
    expect(isValidFeedName("member-billing")).toBe(true);
    expect(isServableAsShared("member-billing")).toBe(false);
  });

  test("every member feed name is refused as shared, whatever it is called", () => {
    for (const suffix of ["billing", "seat", "membership", "minecraft", "x"]) {
      expect(isServableAsShared(`${MEMBER_FEED_PREFIX}${suffix}`), suffix).toBe(false);
    }
  });

  test("a shared feed is servable as shared", () => {
    expect(isServableAsShared("quantumpc")).toBe(true);
    expect(isServableAsShared("claude-seats")).toBe(true);
  });

  // "membership" without the prefix is a DIFFERENT, shared feed and must stay servable —
  // otherwise the guard would be a substring match and would quietly break shared feeds
  // whose name happens to contain the word.
  test("the prefix is a prefix, not a substring", () => {
    expect(isServableAsShared("membership")).toBe(true);
    expect(isServableAsShared("remember-me")).toBe(true);
    expect(isMemberFeed("remember-me")).toBe(false);
  });
});
