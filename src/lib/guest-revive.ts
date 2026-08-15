import { prisma } from "./prisma";
import { logger } from "./logger";

/**
 * The guest came back (new enquiry, inbound WhatsApp/email/call) on a record
 * that was soft-deleted — un-hides it instead of letting the re-contact break
 * or vanish.
 *
 * Without this, a soft-deleted guest is invisible to findReturningGuest (which
 * filters deletedAt: null), so the create path falls through to
 * prisma.guest.create() with a phone/email that is still @unique on the hidden
 * row — a P2002 that surfaces as "Invalid payload" to the enquiry webhook, or
 * as a message quietly filed against a guest nobody can see on the WhatsApp
 * path. Reviving keeps the guest's history, tags and health record in ONE
 * record rather than splitting or dropping it.
 *
 * This is the guest-level twin of reviveEnquiryIfDeleted() — same reasoning,
 * one level up. No-ops if the guest isn't actually soft-deleted.
 *
 * Deliberately does NOT revive a blocked guest's block: isBlocked is left
 * exactly as it is, so a guest who was blocked and then deleted stays blocked
 * on their way back in. The inbound WhatsApp/email handlers check isBlocked
 * before they ever get here.
 */
export async function reviveGuestIfDeleted(
  guestId: string,
  reason: string,
): Promise<boolean> {
  const guest = await prisma.guest.findUnique({
    where: { id: guestId },
    select: { deletedAt: true, fullName: true },
  });
  if (!guest?.deletedAt) return false;

  await prisma.guest.update({
    where: { id: guestId },
    data: { deletedAt: null, isReturning: true },
  });
  await prisma.activity.create({
    data: {
      guestId,
      actorSub: "system",
      actorRole: "system",
      actorName: "Auto-revive",
      actionType: "guest_revived",
      metadata: { reason, deletedAt: guest.deletedAt.toISOString() },
    },
  });
  logger.info(
    { guestId, guestName: guest.fullName, reason, wasDeletedAt: guest.deletedAt },
    "guest revived after re-contact",
  );
  return true;
}
