import { describe, expect, it } from "vitest";
import { tagsForMoment, windowState } from "./scheduled-tag";

const window = (tag: string, from: string, to: string, enabled = true) => ({
  tag,
  startsAt: new Date(from),
  endsAt: new Date(to),
  enabled,
});

const RULES = [
  window("diwali-post", "2026-11-01T00:00:00Z", "2026-11-10T23:59:59Z"),
  window("instagram-live", "2026-11-05T10:00:00Z", "2026-11-05T12:00:00Z"),
  window("old-campaign", "2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z"),
];

describe("tagsForMoment", () => {
  it("tags a message with every window that is open when it arrives", () => {
    // Two campaigns can run at once on one number; a guest who writes during
    // both came from both as far as anyone can tell.
    expect(tagsForMoment(RULES, new Date("2026-11-05T11:00:00Z")).sort()).toEqual(["diwali-post", "instagram-live"]);
  });

  it("tags nothing outside every window", () => {
    expect(tagsForMoment(RULES, new Date("2026-10-15T09:00:00Z"))).toEqual([]);
  });

  it("includes both ends of the window", () => {
    // Someone who sets 10:00–12:00 means a message at exactly 12:00 counts.
    expect(tagsForMoment(RULES, new Date("2026-11-05T10:00:00Z"))).toContain("instagram-live");
    expect(tagsForMoment(RULES, new Date("2026-11-05T12:00:00Z"))).toContain("instagram-live");
    expect(tagsForMoment(RULES, new Date("2026-11-05T12:00:01Z"))).not.toContain("instagram-live");
  });

  it("ignores a window that has been switched off", () => {
    const off = [window("paused", "2026-11-01T00:00:00Z", "2026-11-10T00:00:00Z", false)];
    expect(tagsForMoment(off, new Date("2026-11-05T00:00:00Z"))).toEqual([]);
  });

  it("never returns the same tag twice when two windows share it", () => {
    const same = [
      window("detox", "2026-11-01T00:00:00Z", "2026-11-30T00:00:00Z"),
      window("detox", "2026-11-04T00:00:00Z", "2026-11-06T00:00:00Z"),
    ];
    expect(tagsForMoment(same, new Date("2026-11-05T00:00:00Z"))).toEqual(["detox"]);
  });
});

describe("windowState", () => {
  const now = new Date("2026-11-05T11:00:00Z");
  it("says where a window sits relative to now", () => {
    expect(windowState(RULES[0], now)).toBe("running");
    expect(windowState(RULES[2], now)).toBe("finished");
    expect(windowState(window("later", "2026-12-01T00:00:00Z", "2026-12-05T00:00:00Z"), now)).toBe("upcoming");
    expect(windowState(window("off", "2026-11-01T00:00:00Z", "2026-11-30T00:00:00Z", false), now)).toBe("off");
  });
});
