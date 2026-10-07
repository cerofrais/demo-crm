import { describe, expect, it } from "vitest";
import { affectsVisited, isStayGuestTag } from "./guest-visits";

describe("isStayGuestTag", () => {
  it("recognises the past-stay import batches", () => {
    for (const t of ["ind-2026-stay-guests-a-to-f", "ind-2026-stay-guests-r", "ind-2026-stay-guests-extras", "stay-guests"]) {
      expect(isStayGuestTag(t), t).toBe(true);
    }
  });

  it("ignores enquiry and campaign lists", () => {
    for (const t of ["ind-2026-enquiries-a-to-b", "ind-2026-new-leads-a-to-g", "camp-pre-midaug-a-to-c", "overstay-guestsx", "revisit"]) {
      expect(isStayGuestTag(t), t).toBe(false);
    }
  });
});

describe("affectsVisited", () => {
  it("is true only when a move crosses into or out of Booking Confirmed / Converted", () => {
    expect(affectsVisited("payment_received", "booking_confirmed")).toBe(true);
    expect(affectsVisited("booking_confirmed", "converted")).toBe(true);
    expect(affectsVisited("converted", "rnr")).toBe(true);
    expect(affectsVisited("new_lead", "rnr")).toBe(false);
    expect(affectsVisited("converted", "converted")).toBe(false);
  });
});
