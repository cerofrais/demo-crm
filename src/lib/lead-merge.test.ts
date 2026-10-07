import { describe, expect, it } from "vitest";
import { guestFieldsToMove, mergeScope } from "./lead-merge";

describe("mergeScope", () => {
  it("takes only the losing card's rows when both cards are one person", () => {
    // WhatsApp and email are keyed to the guest, so on one guest they are
    // already shared. Sweeping by guest would move the SURVIVOR's own messages
    // too, and an undo would then hand them to the card being put back.
    expect(mergeScope(true, "lead-a", "guest-1")).toEqual({ enquiryId: "lead-a" });
  });

  it("takes the whole person's history when the cards are two guest records", () => {
    expect(mergeScope(false, "lead-a", "guest-1")).toEqual({
      OR: [{ enquiryId: "lead-a" }, { guestId: "guest-1" }],
    });
  });
});

describe("guestFieldsToMove", () => {
  it("fills in what the surviving card is missing", () => {
    const source = { phone: "+919825326177", email: "d@example.com", city: "Hyderabad" };
    const target = { phone: null, email: "kept@example.com", city: undefined };
    expect(guestFieldsToMove(source, target)).toEqual(["phone", "city"]);
  });

  it("never overwrites what the surviving card already has", () => {
    // The card being kept is the one the business trusts; a merge is not the
    // place to argue with its phone number.
    const source = { phone: "+910000000000" };
    const target = { phone: "+919825326177" };
    expect(guestFieldsToMove(source, target)).toEqual([]);
  });

  it("moves nothing when the other card knows nothing", () => {
    expect(guestFieldsToMove({}, { phone: null })).toEqual([]);
    expect(guestFieldsToMove({ phone: "" }, { phone: null })).toEqual([]);
  });
});
