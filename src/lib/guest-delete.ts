import { prisma } from "./prisma";
import { logger } from "./logger";
import { deleteObject } from "./storage";
import { ApiError } from "./api";

export type GuestDeleteMode = "soft" | "hard";

/**
 * Shared by the single-guest DELETE route and the bulk-delete route.
 *
 * soft: the guest (and their enquiries/notes/tasks/messages/calls/documents
 *   history) is kept, just excluded from guest search and the leads pipeline
 *   going forward — the same DPDP-erasure pattern already used for leads.
 *   Fully reversible by clearing deletedAt.
 *
 * hard: wipes EVERYTHING tied to this guest — every enquiry (with its
 *   notes/tasks cascading), every WhatsApp/email conversation, every call,
 *   every document (+ storage objects), the activity audit log, AI
 *   decisions, and memberships — then removes the Guest row itself.
 *   Irreversible.
 */
export async function deleteGuestRecord(
  guestId: string,
  mode: GuestDeleteMode,
  deletedBySub: string,
): Promise<{ fullName: string }> {
  const current = await prisma.guest.findFirst({
    where: { id: guestId, ...(mode === "soft" ? { deletedAt: null } : {}) },
    select: { fullName: true },
  });
  if (!current) throw new ApiError("NOT_FOUND", "Guest not found", 404);

  if (mode === "hard") {
    const docs = await prisma.document.findMany({
      where: { guestId },
      select: { storageKey: true },
    });

    // Delete order respects FK restrict: AiDecision before Call (callId),
    // Message before Document (attachmentDocumentId), Enquiry last among
    // relational rows (Task/Note cascade with it), Guest last of all
    // (HealthProfile cascades with it).
    await prisma.$transaction([
      prisma.aiDecision.deleteMany({ where: { guestId } }),
      prisma.message.deleteMany({ where: { guestId } }),
      prisma.call.deleteMany({ where: { guestId } }),
      prisma.document.deleteMany({ where: { guestId } }),
      prisma.activity.deleteMany({ where: { guestId } }),
      prisma.membership.deleteMany({ where: { guestId } }),
      prisma.enquiry.deleteMany({ where: { guestId } }),
      prisma.guest.delete({ where: { id: guestId } }),
    ]);

    await Promise.all(
      docs.map((d) =>
        deleteObject(d.storageKey).catch((err) =>
          logger.error({ err, storageKey: d.storageKey }, "guest hard-delete: failed to remove storage object"),
        ),
      ),
    );

    logger.info({ guestId, guestName: current.fullName, deletedBySub }, "guest hard-deleted — all history wiped");
  } else {
    await prisma.guest.update({ where: { id: guestId }, data: { deletedAt: new Date() } });
    logger.info({ guestId, guestName: current.fullName, deletedBySub }, "guest soft-deleted");
  }

  return { fullName: current.fullName };
}
