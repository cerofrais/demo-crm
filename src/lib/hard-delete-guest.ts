/**
 * What a hard delete leaves on the Guest row.
 *
 * A hard delete wipes a guest's engagement history — messages, calls,
 * documents, activity, AI decisions — and keeps only the Guest row, so the
 * number can come back as a genuinely clean new lead. But the Guest row also
 * carries state DERIVED from that history, and it used to survive:
 *
 *  • tags — above all the `wa:` line tags, which record which of our numbers
 *    the guest has talked on. A lead hard-deleted and then messaged from the
 *    60 line came back tagged 60 AND 61: the 61 tag described an August
 *    broadcast whose messages the delete had just removed.
 *  • isReturning — the new lead was logged as a returning guest.
 *  • the AI return score / next-programme insight, scored from that history.
 *
 * What stays: identity and consent (the reason the row is kept), and a block.
 * Blocking is a safety decision about the person, not their history — the
 * inbound webhook refuses a blocked number before any lead exists, and a
 * delete must not quietly lift that.
 */
import type { Prisma } from "@prisma/client";

export function guestResetAfterHardDelete(guest: {
  isBlocked: boolean;
}): Prisma.GuestUpdateInput {
  return {
    tags: guest.isBlocked ? ["blocked"] : [],
    aiReturnScore: null,
    aiReturnReason: null,
    aiNextProgram: null,
    aiInsightAt: null,
    // isReturning is NOT set here: the guest may still have another lead
    // that reached Booking Confirmed. The route recomputes it from what
    // remains, with refreshGuestVisited, once the delete has run.
  };
}
