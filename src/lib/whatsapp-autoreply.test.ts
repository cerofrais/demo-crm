import { describe, expect, it } from "vitest";
import { matchAutoReply, isWithinSchedule } from "./whatsapp-autoreply";

interface Fixture {
  id: string;
  triggerWord: string | null;
  enabled: boolean;
}

describe("matchAutoReply", () => {
  it("returns null when nothing matches and there's no catch-all", () => {
    const rules: Fixture[] = [{ id: "1", triggerWord: "price", enabled: true }];
    expect(matchAutoReply(rules, "hi there")).toBeNull();
  });

  it("matches a trigger word as a case-insensitive substring anywhere in the body", () => {
    const rules: Fixture[] = [{ id: "1", triggerWord: "Price", enabled: true }];
    expect(matchAutoReply(rules, "what's the PRICE for a week?")?.id).toBe("1");
  });

  it("prefers a specific trigger over a blank catch-all", () => {
    const rules: Fixture[] = [
      { id: "catchall", triggerWord: "", enabled: true },
      { id: "specific", triggerWord: "hello", enabled: true },
    ];
    expect(matchAutoReply(rules, "hello there")?.id).toBe("specific");
  });

  it("falls back to the catch-all when no trigger word matches", () => {
    const rules: Fixture[] = [
      { id: "catchall", triggerWord: null, enabled: true },
      { id: "specific", triggerWord: "hello", enabled: true },
    ];
    expect(matchAutoReply(rules, "good morning")?.id).toBe("catchall");
  });

  it("ignores disabled rules entirely, including a disabled catch-all", () => {
    const rules: Fixture[] = [
      { id: "off", triggerWord: null, enabled: false },
      { id: "on", triggerWord: "hello", enabled: true },
    ];
    expect(matchAutoReply(rules, "good morning")).toBeNull();
    expect(matchAutoReply(rules, "hello!")?.id).toBe("on");
  });

  it("first-created specific match wins when multiple trigger words match", () => {
    const rules: Fixture[] = [
      { id: "first", triggerWord: "book", enabled: true },
      { id: "second", triggerWord: "booking", enabled: true },
    ];
    expect(matchAutoReply(rules, "I'd like to make a booking")?.id).toBe("first");
  });
});

describe("isWithinSchedule", () => {
  // 09:00 IST = 03:30 UTC; IST = UTC+5:30 with no DST.
  const at = (utcHour: number, utcMin: number) => new Date(Date.UTC(2026, 0, 15, utcHour, utcMin));

  it("no window at all means always on", () => {
    expect(isWithinSchedule(null, null, at(0, 0))).toBe(true);
    expect(isWithinSchedule(null, null, at(12, 0))).toBe(true);
  });

  it("a half-set window is treated as always on, not guessed", () => {
    expect(isWithinSchedule(540, null, at(0, 0))).toBe(true);
    expect(isWithinSchedule(null, 1080, at(0, 0))).toBe(true);
  });

  it("daytime window (9:00–18:00 IST) is open inside, closed outside", () => {
    // 03:30 UTC = 09:00 IST — inclusive start
    expect(isWithinSchedule(540, 1080, at(3, 30))).toBe(true);
    // 06:30 UTC = 12:00 IST — mid-window
    expect(isWithinSchedule(540, 1080, at(6, 30))).toBe(true);
    // 12:30 UTC = 18:00 IST — exclusive end
    expect(isWithinSchedule(540, 1080, at(12, 30))).toBe(false);
    // 01:00 UTC = 06:30 IST — before opening
    expect(isWithinSchedule(540, 1080, at(1, 0))).toBe(false);
  });

  it("overnight window (22:00–06:00 IST) wraps midnight", () => {
    // 17:30 UTC = 23:00 IST — late evening, inside
    expect(isWithinSchedule(1320, 360, at(17, 30))).toBe(true);
    // 22:30 UTC = 04:00 IST next day — small hours, inside
    expect(isWithinSchedule(1320, 360, at(22, 30))).toBe(true);
    // 06:30 UTC = 12:00 IST — daytime, outside
    expect(isWithinSchedule(1320, 360, at(6, 30))).toBe(false);
  });
});
