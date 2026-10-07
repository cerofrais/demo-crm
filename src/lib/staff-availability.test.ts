import { describe, expect, it } from "vitest";
import { istToday, isWeeklyOff, isWithinShift, istMinutesOfDay } from "./staff-availability";

/**
 * The whole feature rests on "today" meaning today in IST. Reading it off a
 * UTC clock puts the day boundary at 05:30 local, so a Monday off would run
 * 05:30 Mon → 05:30 Tue: Monday's early leads route to the person who is off,
 * and Tuesday's skip someone who is working.
 */
describe("istToday", () => {
  it("reads the date in IST, not UTC", () => {
    // 2026-09-07 20:00 UTC is already 2026-09-08 01:30 in IST.
    expect(istToday(new Date("2026-09-07T20:00:00Z")).date).toBe("2026-09-08");
  });

  it("does not roll the day over early", () => {
    // 2026-09-07 18:00 UTC is 23:30 IST — still the 7th.
    expect(istToday(new Date("2026-09-07T18:00:00Z")).date).toBe("2026-09-07");
  });

  it("puts the boundary at IST midnight, i.e. 18:30 UTC", () => {
    expect(istToday(new Date("2026-09-07T18:29:59Z")).date).toBe("2026-09-07");
    expect(istToday(new Date("2026-09-07T18:30:00Z")).date).toBe("2026-09-08");
  });

  it("returns the IST weekday, with Sunday as 0", () => {
    // 2026-09-07 is a Monday in IST.
    expect(istToday(new Date("2026-09-07T06:00:00Z")).weekday).toBe(1);
    // 22:00 UTC Sunday is already Monday 03:30 IST — the case a UTC read
    // would get wrong, and the one that decides a Monday-off rota.
    expect(istToday(new Date("2026-09-06T22:00:00Z")).weekday).toBe(1);
  });

  it("covers a full week", () => {
    const days = [
      ["2026-09-06T06:00:00Z", 0], // Sunday
      ["2026-09-07T06:00:00Z", 1],
      ["2026-09-08T06:00:00Z", 2],
      ["2026-09-09T06:00:00Z", 3],
      ["2026-09-10T06:00:00Z", 4],
      ["2026-09-11T06:00:00Z", 5],
      ["2026-09-12T06:00:00Z", 6], // Saturday
    ] as const;
    for (const [iso, expected] of days) {
      expect(istToday(new Date(iso)).weekday).toBe(expected);
    }
  });
});

describe("isWeeklyOff", () => {
  it("matches a configured rota day", () => {
    expect(isWeeklyOff([1], 1)).toBe(true);
    expect(isWeeklyOff([1], 2)).toBe(false);
  });

  it("supports more than one day off a week", () => {
    expect(isWeeklyOff([0, 3], 3)).toBe(true);
    expect(isWeeklyOff([0, 3], 4)).toBe(false);
  });

  it("treats no rota as working every day", () => {
    // Nobody is off by default — an empty or missing rota must never remove
    // somebody from the rotation.
    expect(isWeeklyOff([], 1)).toBe(false);
    expect(isWeeklyOff(null, 1)).toBe(false);
    expect(isWeeklyOff(undefined, 1)).toBe(false);
  });

  it("does not treat Sunday's 0 as falsy", () => {
    // A rota of [0] is Sunday off, not "no rota".
    expect(isWeeklyOff([0], 0)).toBe(true);
  });
});

const at = (h: number, m = 0) => h * 60 + m;

describe("istMinutesOfDay", () => {
  it("counts minutes from IST midnight, not the server's", () => {
    // 02:30 UTC is 08:00 IST.
    expect(istMinutesOfDay(new Date("2026-09-08T02:30:00Z"))).toBe(at(8));
    // 18:30 UTC is IST midnight.
    expect(istMinutesOfDay(new Date("2026-09-08T18:30:00Z"))).toBe(0);
  });
});

/**
 * The night shift is the whole reason this function exists. 22:00→06:00 is
 * start 1320, end 360 — read naively as `now >= start && now < end` it is
 * never true, so a night worker would be permanently off duty and silently
 * excluded from every pool.
 */
describe("isWithinShift", () => {
  const DAY = { start: at(9), end: at(18) };     // 09:00–18:00, Prashanth
  const NIGHT = { start: at(22), end: at(6) };   // 22:00–06:00, Joel

  it("handles an ordinary daytime shift", () => {
    expect(isWithinShift(at(9), DAY.start, DAY.end)).toBe(true);
    expect(isWithinShift(at(13), DAY.start, DAY.end)).toBe(true);
    expect(isWithinShift(at(8, 59), DAY.start, DAY.end)).toBe(false);
    expect(isWithinShift(at(22), DAY.start, DAY.end)).toBe(false);
  });

  it("treats the end as exclusive and the start as inclusive", () => {
    expect(isWithinShift(DAY.start, DAY.start, DAY.end)).toBe(true);
    expect(isWithinShift(DAY.end, DAY.start, DAY.end)).toBe(false);
    expect(isWithinShift(DAY.end - 1, DAY.start, DAY.end)).toBe(true);
  });

  it("covers a night shift on BOTH sides of midnight", () => {
    expect(isWithinShift(at(22), NIGHT.start, NIGHT.end)).toBe(true);
    expect(isWithinShift(at(23, 59), NIGHT.start, NIGHT.end)).toBe(true);
    expect(isWithinShift(at(0), NIGHT.start, NIGHT.end)).toBe(true);
    expect(isWithinShift(at(3), NIGHT.start, NIGHT.end)).toBe(true);
    expect(isWithinShift(at(5, 59), NIGHT.start, NIGHT.end)).toBe(true);
  });

  it("excludes the daytime hours a night worker is asleep for", () => {
    expect(isWithinShift(at(6), NIGHT.start, NIGHT.end)).toBe(false);
    expect(isWithinShift(at(13), NIGHT.start, NIGHT.end)).toBe(false);
    expect(isWithinShift(at(21, 59), NIGHT.start, NIGHT.end)).toBe(false);
  });

  it("never has the two shifts both cover the same instant, nor leave a gap", () => {
    // Every minute of the day belongs to exactly one of a 06:00-22:00 day
    // shift and a 22:00-06:00 night shift.
    for (let m = 0; m < 1440; m++) {
      const day = isWithinShift(m, at(6), at(22));
      const night = isWithinShift(m, at(22), at(6));
      expect(day !== night).toBe(true);
    }
  });

  it("reads start === end as a 24-hour shift, not a zero-length one", () => {
    // Reading it as "never" would quietly remove somebody from routing.
    expect(isWithinShift(at(3), at(9), at(9))).toBe(true);
    expect(isWithinShift(at(15), at(9), at(9))).toBe(true);
  });
});
