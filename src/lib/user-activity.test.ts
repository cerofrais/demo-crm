import { describe, expect, it } from "vitest";
import { buildRows, BUCKETS_PER_DAY, istDayStart, istToday, isDay, nowBucketFor } from "./user-activity";

describe("IST day and slots", () => {
  it("starts the day at 00:00 IST", () => {
    expect(istDayStart("2026-09-16").toISOString()).toBe("2026-09-15T18:30:00.000Z");
  });

  it("knows which slot 'now' is in, and that a past day has none", () => {
    const now = new Date("2026-09-16T05:05:00Z"); // 10:35 IST → slot 63
    expect(istToday(now)).toBe("2026-09-16");
    expect(nowBucketFor("2026-09-16", now)).toBe(63);
    expect(nowBucketFor("2026-09-15", now)).toBeNull();
    expect(nowBucketFor("2026-09-17", now)).toBe(-1);
  });

  it("validates day strings", () => {
    expect(isDay("2026-09-16")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
  });
});

describe("buildRows", () => {
  const staff = [
    { sub: "a", name: "Asha", role: "SALES" },
    { sub: "b", name: "Bala", role: "RECEPTION" },
    { sub: "c", name: "Chitra", role: "MANAGER" },
  ];

  it("fills slot counts, totals and active slots per person", () => {
    const rows = buildRows(
      [
        { sub: "a", bucket: 60, n: 3 },
        { sub: "a", bucket: 61, n: 1 },
        { sub: "b", bucket: 60, n: 5 },
      ],
      [
        { sub: "a", name: "Old name", role: "SALES", firstAt: new Date("2026-09-16T04:30:00Z"), lastAt: new Date("2026-09-16T04:45:00Z") },
        { sub: "b", name: "Bala", role: "RECEPTION", firstAt: null, lastAt: null },
      ],
      staff,
    );
    const a = rows.find((r) => r.sub === "a")!;
    expect(a.counts).toHaveLength(BUCKETS_PER_DAY);
    expect(a.counts[60]).toBe(3);
    expect(a.total).toBe(4);
    expect(a.activeBuckets).toBe(2);
    expect(a.name).toBe("Asha"); // current directory name wins over the cached one
  });

  it("includes staff with no activity at all, last", () => {
    const rows = buildRows([{ sub: "b", bucket: 1, n: 1 }], [{ sub: "b", name: "Bala", role: null, firstAt: null, lastAt: null }], staff);
    expect(rows.map((r) => r.sub)).toEqual(["b", "a", "c"]);
    expect(rows[1].activeBuckets).toBe(0);
  });

  it("keeps someone who acted but is no longer in the directory", () => {
    const rows = buildRows([{ sub: "x", bucket: 5, n: 2 }], [{ sub: "x", name: "Former", role: "SALES", firstAt: null, lastAt: null }], []);
    expect(rows[0]).toMatchObject({ sub: "x", name: "Former", total: 2 });
  });

  it("ignores slots outside the day", () => {
    const rows = buildRows([{ sub: "a", bucket: BUCKETS_PER_DAY, n: 9 }], [], staff);
    expect(rows.find((r) => r.sub === "a")!.total).toBe(0);
  });
});
