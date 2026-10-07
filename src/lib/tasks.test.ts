import { describe, expect, it } from "vitest";
import { nextEightAmIst } from "./tasks";

/**
 * The Payment Pending chase is due at 08:00 IST. Built from a local-time
 * constructor it would follow the SERVER's timezone and land at 08:00 UTC —
 * 13:30 IST, well past the morning it exists for — so the offset is applied
 * explicitly and pinned here.
 */
describe("nextEightAmIst", () => {
  const istHour = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);

  it("always lands on 08:00 IST", () => {
    for (const iso of [
      "2026-09-08T00:00:00Z",
      "2026-09-08T06:00:00Z",
      "2026-09-08T18:45:00Z",
      "2026-09-08T23:59:59Z",
    ]) {
      expect(istHour(nextEightAmIst(new Date(iso)))).toBe("08:00");
    }
  });

  it("is 02:30 UTC — the same calendar day, since IST is UTC+5:30", () => {
    expect(nextEightAmIst(new Date("2026-09-08T00:00:00Z")).toISOString()).toBe(
      "2026-09-08T02:30:00.000Z",
    );
  });

  it("uses today's 8am when it is still ahead", () => {
    // 01:00 UTC is 06:30 IST — this morning's 8am has not happened yet.
    expect(nextEightAmIst(new Date("2026-09-08T01:00:00Z")).toISOString()).toBe(
      "2026-09-08T02:30:00.000Z",
    );
  });

  it("rolls to tomorrow once 8am has passed", () => {
    // 03:00 UTC is 08:30 IST — this morning is gone.
    expect(nextEightAmIst(new Date("2026-09-08T03:00:00Z")).toISOString()).toBe(
      "2026-09-09T02:30:00.000Z",
    );
  });

  it("treats exactly 8am as passed rather than scheduling for right now", () => {
    expect(nextEightAmIst(new Date("2026-09-08T02:30:00Z")).toISOString()).toBe(
      "2026-09-09T02:30:00.000Z",
    );
  });

  it("rolls the month and year over correctly", () => {
    expect(nextEightAmIst(new Date("2026-09-30T12:00:00Z")).toISOString()).toBe(
      "2026-10-01T02:30:00.000Z",
    );
    expect(nextEightAmIst(new Date("2026-12-31T12:00:00Z")).toISOString()).toBe(
      "2027-01-01T02:30:00.000Z",
    );
  });
});
