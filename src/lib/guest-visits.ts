/**
 * Has this guest actually stayed with us? That is what "Returning guest", the
 * `revisit` tag and the drawer's "Previously visited" banner mean.
 *
 * Guest.isReturning used to be set whenever a new enquiry, form or revived
 * record matched an existing guest by phone or email — so a second lead-ad
 * submission from someone who had never visited showed "Returning guest —
 * health & preference history is on file", with no health record anywhere.
 * It now means one of:
 *  • one of their leads reached Booking Confirmed or Converted, or
 *  • they were bulk-imported from a past-stay list (an `…stay-guests…` batch
 *    tag, e.g. `ind-2026-stay-guests-a-to-f`).
 *
 * Enquiry.isReturningFlag is that answer at the moment the lead was created,
 * so a guest's first booking doesn't turn the lead that booked it into a
 * "revisit".
 */
import { prisma } from "./prisma";
import { isPostBookingStage } from "./rbac";

const VISITED_STAGES = ["booking_confirmed", "converted"] as const;

/** A bulk-import batch tag for guests who have stayed before. */
export function isStayGuestTag(tag: string): boolean {
  return /(^|-)stay-guests(-|$)/.test(tag);
}

/**
 * Recompute Guest.isReturning from their leads and tags. Call after a lead's
 * stage moves into or out of Booking Confirmed / Converted.
 */
export async function refreshGuestVisited(guestId: string): Promise<boolean> {
  const guest = await prisma.guest.findUnique({
    where: { id: guestId },
    select: { isReturning: true, tags: true },
  });
  if (!guest) return false;
  const booked = await prisma.enquiry.count({
    where: { guestId, deletedAt: null, stage: { in: [...VISITED_STAGES] } },
  });
  const visited = booked > 0 || guest.tags.some(isStayGuestTag);
  if (visited !== guest.isReturning) {
    await prisma.guest.update({ where: { id: guestId }, data: { isReturning: visited } });
  }
  return visited;
}

/** Whether a stage change can change the answer above. */
export function affectsVisited(from: string, to: string): boolean {
  return from !== to && (isPostBookingStage(from) || isPostBookingStage(to));
}
