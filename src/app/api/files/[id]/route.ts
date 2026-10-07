import { NextRequest, NextResponse } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import {
  canReadDocCategory,
  canDeleteDocuments,
  can,
  type DocCategory,
  canReadAllGuestData,
} from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { presignDownload, deleteObject, isInlineType } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** How long one person's repeat views of the same file count as one view. */
const VIEW_AUDIT_WINDOW_MS = 60 * 60 * 1000;

// GET /api/files/:id — permission check → presigned URL → redirect (logged)
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const ctx = await requireSession();
  const doc = await prisma.document.findUnique({ where: { id: params.id } });
  if (!doc) throw new ApiError("NOT_FOUND", "Document not found", 404);
  if (!canReadDocCategory(ctx.roles, doc.category as DocCategory)) {
    throw new ApiError("FORBIDDEN", "No access to this document", 403);
  }

  // F40: role-only category access isn't enough for lead-scoped callers
  // (Reception AND read-only Staff) — they may only download docs on their own
  // guests/enquiries. Broad access stays for leads.manage (Admin/Manager) and
  // health.view (Doctor). Shared library files (no guest + no enquiry) remain
  // accessible to everyone.
  if (!canReadAllGuestData(ctx.roles)) {
    const isGeneral = doc.guestId === null && doc.enquiryId === null;
    const owned =
      isGeneral ||
      (await prisma.document.count({
        where: {
          id: doc.id,
          OR: [
            { enquiry: { assignedToSub: ctx.sub } },
            { guest: { enquiries: { some: { assignedToSub: ctx.sub } } } },
          ],
        },
      })) > 0;
    if (!owned) {
      throw new ApiError("FORBIDDEN", "No access to this document", 403);
    }
  }

  const inline = req.nextUrl.searchParams.get("inline") === "1" && isInlineType(doc.mimeType);
  const url = await presignDownload(doc.storageKey, doc.filename, { inline });

  // The rich editor shows an embedded image through this route (editor-cid-
  // preview.ts), and re-fetches it on every render of the page it sits on — a
  // footer logo would log a "download" each time anyone opened Message
  // Templates. For a shared library image that is not a download of anyone's
  // data: it belongs to no guest. Skipped for exactly that case and no other;
  // a guest's document is logged however it is fetched.
  const isLibraryImagePreview =
    req.nextUrl.searchParams.get("preview") === "1" &&
    inline &&
    doc.mimeType.startsWith("image/") &&
    doc.guestId === null &&
    doc.enquiryId === null;

  // An inline fetch is a render, not a download: the activity log now shows
  // photos and plays voice notes in place, so one visit to a lead's timeline
  // asks for every image on it, and re-opening the tab asks again. Logging
  // each of those wrote dozens of "doc_download" rows into the very log being
  // read, and buried the real accesses in them.
  //
  // The audit still answers the question it exists to answer — who looked at
  // this document, and when — by keeping one row per person per document per
  // hour. An explicit download (no inline flag) is always logged: that is
  // someone taking a copy away, which is a different act.
  const alreadyLogged =
    inline &&
    (await prisma.activity.findFirst({
      where: {
        actorSub: ctx.sub,
        actionType: "doc_download",
        createdAt: { gte: new Date(Date.now() - VIEW_AUDIT_WINDOW_MS) },
        metadata: { path: ["documentId"], equals: doc.id },
      },
      select: { id: true },
    }));

  // DPDP audit trail: log every download.
  if (!isLibraryImagePreview && !alreadyLogged) {
    await prisma.activity.create({
      data: {
        guestId: doc.guestId,
        enquiryId: doc.enquiryId,
        actorSub: ctx.sub,
        actorRole: ctx.roles[0] ?? "STAFF",
        actorName: ctx.name,
        actionType: "doc_download",
        metadata: { documentId: doc.id, filename: doc.filename },
      },
    });
  }

  return NextResponse.redirect(url);
}

// DELETE /api/files/:id — admin only; removes object + record
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!canDeleteDocuments(ctx.roles)) {
      throw new ApiError("FORBIDDEN", "Only admins can delete documents", 403);
    }
    const doc = await prisma.document.findUnique({ where: { id: params.id } });
    if (!doc) throw new ApiError("NOT_FOUND", "Document not found", 404);

    await deleteObject(doc.storageKey).catch(() => {
      /* object may already be gone; still remove the record */
    });
    await prisma.document.delete({ where: { id: params.id } });

    return ok({ deleted: true });
  });
}
