import { describe, expect, it } from "vitest";
import { lastActive } from "./last-active";

// 16 Sep 2026, 3:00 PM IST
const now = new Date("2026-09-16T09:30:00Z");
const ago = (mins: number) => new Date(now.getTime() - mins * 60_000).toISOString();

describe("lastActive", () => {
  it("is active now within ten minutes", () => {
    expect(lastActive(ago(0), now)).toMatchObject({ state: "now", label: "Active now" });
    expect(lastActive(ago(9), now).state).toBe("now");
    expect(lastActive(ago(10), now)).toMatchObject({ state: "today", label: "10 min ago" });
  });

  it("counts hours earlier the same IST day", () => {
    expect(lastActive(ago(185), now)).toMatchObject({ state: "today", label: "3h ago" });
  });

  it("says yesterday across IST midnight, not UTC midnight", () => {
    // 11:50 PM IST on the 15th is still the 15th in UTC too, but 12:10 AM IST
    // on the 16th is the 15th in UTC — that one must count as today.
    expect(lastActive("2026-09-15T18:20:00Z", now).label).toMatch(/^Yesterday, /);
    expect(lastActive("2026-09-15T18:40:00Z", now)).toMatchObject({ state: "today" });
  });

  it("uses the weekday within a week and the date after", () => {
    expect(lastActive("2026-09-12T06:00:00Z", now).label).toMatch(/^Sat, /);
    expect(lastActive("2026-08-20T06:00:00Z", now).label).toBe("20 Aug 2026");
  });

  it("handles someone who has never done anything", () => {
    expect(lastActive(null, now)).toEqual({ state: "never", label: "No activity yet", exact: null });
  });
});
