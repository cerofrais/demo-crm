import { describe, expect, it } from "vitest";
import { matchesRnrFilter } from "./enquiries";

describe("matchesRnrFilter", () => {
  it("buckets a standard 3-call cadence", () => {
    expect(matchesRnrFilter({ done: 0, total: 3 }, "none")).toBe(true);
    expect(matchesRnrFilter({ done: 1, total: 3 }, "partial")).toBe(true);
    expect(matchesRnrFilter({ done: 3, total: 3 }, "all")).toBe(true);
  });

  it("'open' is everything still outstanding", () => {
    expect(matchesRnrFilter({ done: 0, total: 3 }, "open")).toBe(true);
    expect(matchesRnrFilter({ done: 2, total: 3 }, "open")).toBe(true);
    expect(matchesRnrFilter({ done: 3, total: 3 }, "open")).toBe(false);
  });

  // A lead that re-enters RNR gets a second cadence — production already has
  // leads on 6 follow-ups. Counting to a hard-coded 3 would report one of
  // these, half-worked, as complete.
  it("handles a re-entered lead with more than 3 follow-ups", () => {
    expect(matchesRnrFilter({ done: 3, total: 6 }, "all")).toBe(false);
    expect(matchesRnrFilter({ done: 3, total: 6 }, "partial")).toBe(true);
    expect(matchesRnrFilter({ done: 3, total: 6 }, "open")).toBe(true);
    expect(matchesRnrFilter({ done: 6, total: 6 }, "all")).toBe(true);
  });

  it("the buckets don't overlap", () => {
    for (const p of [{ done: 0, total: 3 }, { done: 2, total: 3 }, { done: 3, total: 3 }]) {
      const hits = ["none", "partial", "all"].filter((f) => matchesRnrFilter(p, f));
      expect(hits).toHaveLength(1);
    }
  });

  // Never scheduled is not the same as scheduled and ignored.
  it("excludes a lead with no follow-up tasks at all", () => {
    for (const f of ["none", "partial", "all", "open"]) {
      expect(matchesRnrFilter(null, f)).toBe(false);
      expect(matchesRnrFilter({ done: 0, total: 0 }, f)).toBe(false);
    }
  });

  it("ignores a nonsense filter value rather than matching everything", () => {
    expect(matchesRnrFilter({ done: 3, total: 3 }, "banana")).toBe(false);
  });
});
