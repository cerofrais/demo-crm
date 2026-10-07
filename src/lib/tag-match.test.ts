import { describe, expect, it } from "vitest";
import { matchesTags, parseTagMatch, tagListFilter } from "./tag-match";

describe("matchesTags", () => {
  const lead = ["foreign", "hot-lead"];

  it("any: one selected tag is enough", () => {
    expect(matchesTags(lead, ["foreign", "vip"], "any")).toBe(true);
    expect(matchesTags(lead, ["vip"], "any")).toBe(false);
  });

  it("all: every selected tag must be present", () => {
    expect(matchesTags(lead, ["foreign", "hot-lead"], "all")).toBe(true);
    expect(matchesTags(lead, ["foreign", "vip"], "all")).toBe(false);
  });

  it("agree when only one tag is selected", () => {
    expect(matchesTags(lead, ["foreign"], "any")).toBe(matchesTags(lead, ["foreign"], "all"));
  });

  it("matches everything when nothing is selected, in either mode", () => {
    expect(matchesTags([], [], "any")).toBe(true);
    expect(matchesTags([], [], "all")).toBe(true);
  });
});

describe("parseTagMatch", () => {
  it("accepts the two values", () => {
    expect(parseTagMatch("any", "all")).toBe("any");
    expect(parseTagMatch("all", "any")).toBe("all");
  });

  it("falls back to the page's own default for anything else", () => {
    // Guests has always been AND, everything else OR — an old client that
    // sends no parameter must keep getting that.
    expect(parseTagMatch(null, "all")).toBe("all");
    expect(parseTagMatch(undefined, "any")).toBe("any");
    expect(parseTagMatch("AND", "any")).toBe("any");
  });
});

describe("tagListFilter", () => {
  it("maps each mode to the matching Prisma list operator", () => {
    expect(tagListFilter(["a", "b"], "any")).toEqual({ hasSome: ["a", "b"] });
    expect(tagListFilter(["a", "b"], "all")).toEqual({ hasEvery: ["a", "b"] });
  });

  it("is no filter at all for an empty selection", () => {
    expect(tagListFilter([], "all")).toBeUndefined();
  });
});
