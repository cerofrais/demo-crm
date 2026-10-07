import { describe, expect, it } from "vitest";
import { guestResetAfterHardDelete } from "./hard-delete-guest";

describe("guestResetAfterHardDelete", () => {
  it("clears every tag, including the WhatsApp line tags", () => {
    // The bug: a hard-deleted lead re-contacted on the 60 line came back
    // still tagged wa:918712623061 from an August broadcast whose messages
    // the delete had removed.
    expect(guestResetAfterHardDelete({ isBlocked: false }).tags).toEqual([]);
  });

  it("keeps a block — that is a decision about the person, not their history", () => {
    expect(guestResetAfterHardDelete({ isBlocked: true }).tags).toEqual(["blocked"]);
  });

  it("clears the AI insight scored from the wiped history", () => {
    const data = guestResetAfterHardDelete({ isBlocked: false });
    expect(data).toMatchObject({
      aiReturnScore: null,
      aiReturnReason: null,
      aiNextProgram: null,
      aiInsightAt: null,
    });
  });

  it("leaves isReturning to be recomputed from whatever leads remain", () => {
    expect(guestResetAfterHardDelete({ isBlocked: false })).not.toHaveProperty("isReturning");
  });
});
