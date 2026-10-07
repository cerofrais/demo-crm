import { describe, it, expect } from "vitest";
import { toAllowedSet, isNumberAllowed } from "./whatsapp-number-access";

/**
 * Pinning a person to specific WhatsApp lines. The two failure modes worth
 * guarding are the quiet ones: a restriction that stops applying (so the
 * person can send from any line again), and one that locks them out of the
 * line they were meant to have.
 */
describe("toAllowedSet", () => {
  it("treats no list as unrestricted, so existing users keep their access", () => {
    expect(toAllowedSet([])).toBeNull();
    expect(toAllowedSet(undefined)).toBeNull();
    expect(toAllowedSet(null)).toBeNull();
  });

  it("drops entries that are not numbers rather than counting them", () => {
    // A list of only junk must not become an EMPTY restriction that allows
    // nothing — it means nothing was really configured.
    expect(toAllowedSet(["", "   ", "abc"])).toBeNull();
  });
});

describe("isNumberAllowed", () => {
  it("allows every line when unrestricted", () => {
    expect(isNumberAllowed(null, "+918712623060")).toBe(true);
    expect(isNumberAllowed(null, null)).toBe(true);
  });

  it("allows only the pinned lines", () => {
    const allowed = toAllowedSet(["+918712623060"]);
    expect(isNumberAllowed(allowed, "+918712623060")).toBe(true);
    expect(isNumberAllowed(allowed, "+918977766852")).toBe(false);
    expect(isNumberAllowed(allowed, "+918712623061")).toBe(false);
  });

  it("matches however the number is formatted on either side", () => {
    // Stored as typed by an admin; compared against WhatsAppNumber.phoneNumber.
    // A formatting difference must not lock someone out of their own line.
    const allowed = toAllowedSet(["918712623060"]);
    expect(isNumberAllowed(allowed, "+918712623060")).toBe(true);
    expect(isNumberAllowed(toAllowedSet(["+91 87126 23060"]), "+918712623060")).toBe(true);
  });

  it("refuses a line with no phone yet to a restricted person", () => {
    // A line still awaiting its QR scan has nothing to match against; letting
    // it through would make "pending" a way around the restriction.
    expect(isNumberAllowed(toAllowedSet(["+918712623060"]), null)).toBe(false);
    expect(isNumberAllowed(toAllowedSet(["+918712623060"]), "")).toBe(false);
  });
});
