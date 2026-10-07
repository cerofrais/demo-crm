import { describe, it, expect } from "vitest";
import {
  bookingTotalINR,
  formatBookingChanges,
  summarizeBooking,
  type BookingDetails,
} from "./booking-details";

const EMPTY: BookingDetails = {
  occupancy: null,
  companionName: null,
  stayDays: null,
  roomCount: null,
  pricePerDayINR: null,
  roomCategory: null,
};

describe("bookingTotalINR", () => {
  it("multiplies days by the daily rate", () => {
    expect(bookingTotalINR(7, 12000)).toBe(84000);
  });

  it("is null unless both halves are known", () => {
    expect(bookingTotalINR(7, null)).toBeNull();
    expect(bookingTotalINR(null, 12000)).toBeNull();
    expect(bookingTotalINR(undefined, undefined)).toBeNull();
  });

  it("treats a zero rate as a real total, not a missing one", () => {
    // A comped stay is a legitimate booking; `0 || null` would lose it.
    expect(bookingTotalINR(3, 0)).toBe(0);
  });
});

describe("formatBookingChanges", () => {
  it("ignores fields the request never sent", () => {
    expect(formatBookingChanges(EMPTY, {})).toEqual([]);
  });

  it("ignores fields sent with the value they already had", () => {
    // The whole point: saving the drawer after editing only a phone number
    // must not write a booking row.
    const before = { ...EMPTY, occupancy: "double" as const, stayDays: 7 };
    expect(formatBookingChanges(before, { occupancy: "double", stayDays: 7 })).toEqual([]);
  });

  it("labels each change and renders the rate as currency", () => {
    const changes = formatBookingChanges(EMPTY, {
      occupancy: "double",
      companionName: "Priya Sharma",
      stayDays: 7,
      roomCount: 2,
      pricePerDayINR: 12000,
      roomCategory: "premium",
    });
    expect(changes).toEqual([
      "Occupancy: — -> Double",
      "Staying with: — -> Priya Sharma",
      "Days: — -> 7",
      "Rooms: — -> 2",
      expect.stringMatching(/^Price\/day: — -> ₹\s?12,000$/),
      "Room: — -> Premium",
    ]);
  });

  it("shows both sides when a value is replaced", () => {
    const before = { ...EMPTY, stayDays: 5, roomCategory: "executive" as const };
    expect(formatBookingChanges(before, { stayDays: 7, roomCategory: "premium" })).toEqual([
      "Days: 5 -> 7",
      "Room: Executive -> Premium",
    ]);
  });

  it("records a field being cleared", () => {
    const before = { ...EMPTY, occupancy: "double" as const, companionName: "Priya" };
    expect(formatBookingChanges(before, { occupancy: null, companionName: null })).toEqual([
      "Occupancy: Double -> —",
      "Staying with: Priya -> —",
    ]);
  });
});

describe("summarizeBooking", () => {
  it("is null when nothing is set", () => {
    expect(summarizeBooking(EMPTY)).toBeNull();
  });

  it("reads as the booking as it now stands", () => {
    const s = summarizeBooking({
      occupancy: "double",
      companionName: "Priya Sharma",
      stayDays: 7,
      roomCount: 2,
      pricePerDayINR: 12000,
      roomCategory: "premium",
    });
    expect(s).toContain("2 rooms");
    expect(s).toContain("Double occupancy with Priya Sharma");
    expect(s).toContain("7 days");
    expect(s).toMatch(/₹\s?12,000\/day/);
    expect(s).toMatch(/₹\s?84,000 total/);
    expect(s).toContain("Premium");
  });

  it("omits a companion on a single booking", () => {
    // Older rows were written before the drawer cleared the pair, so a stale
    // name can exist on a single — it must not be presented as fact.
    const s = summarizeBooking({ ...EMPTY, occupancy: "single", companionName: "Priya" });
    expect(s).toBe("Single occupancy");
  });

  it("still names a companion when occupancy itself is unset", () => {
    expect(summarizeBooking({ ...EMPTY, companionName: "Priya" })).toBe("Staying with Priya");
  });

  it("uses the singular for a one-day stay and a single room", () => {
    expect(summarizeBooking({ ...EMPTY, stayDays: 1, roomCount: 1 })).toBe("1 day · 1 room");
  });

  it("drops the total when only one half is known", () => {
    const s = summarizeBooking({ ...EMPTY, stayDays: 7 });
    expect(s).toBe("7 days");
  });
});
