import { prisma } from "./prisma";
import { readableDocCategories, type AppRole } from "./rbac";
import type { Document, DocumentCategory } from "@prisma/client";

/**
 * Which existing Document a sender is allowed to attach to an outbound
 * message.
 *
 * Two sources, and only two:
 *
 *   1. A document already attached to THIS guest — what the composer's own
 *      upload creates, and what was previously the only accepted source.
 *   2. A shared Resources-library document — one attached to no guest and no
 *      enquiry. This is what the attachment picker lists, so a rep can send
 *      the standard brochure without re-uploading it per guest.
 *
 * Everything else is refused, which is the point: without the guest/library
 * bound below, `id` alone would let any signed-in caller attach ANY document
 * in the system — including another guest's medical scan — and mail it out.
 *
 * The category gate is the second half of that. A library file can be
 * `medical`, and a role that can't read medical documents in the Resources
 * page must not be able to attach one by id either.
 */
export async function findAttachableDocument(
  documentId: string,
  guestId: string,
  roles: AppRole[],
): Promise<Document | null> {
  return prisma.document.findFirst({
    where: {
      id: documentId,
      category: { in: readableDocCategories(roles) as DocumentCategory[] },
      OR: [
        { guestId },
        // Shared library: unattached on BOTH sides. `guestId: null` alone
        // would also match an enquiry-scoped document belonging to someone
        // else's lead.
        { guestId: null, enquiryId: null },
      ],
    },
  });
}

/**
 * The bulk-email variant: one asset goes to every recipient, so a
 * guest-scoped document is never the right thing to broadcast. Library files
 * only — which is already where the bulk composer's own uploads land, since
 * it signs them with no guestId/enquiryId.
 */
export async function findBroadcastableDocument(
  documentId: string,
  roles: AppRole[],
): Promise<Document | null> {
  return prisma.document.findFirst({
    where: {
      id: documentId,
      guestId: null,
      enquiryId: null,
      category: { in: readableDocCategories(roles) as DocumentCategory[] },
    },
  });
}
