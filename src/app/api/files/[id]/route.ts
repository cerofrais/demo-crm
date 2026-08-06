import { NextRequest, NextResponse } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import {
  canReadDocCategory,
  canDeleteDocuments,
  can,
  type DocCategory,
} from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { presignDownload, deleteObject, isInlineType } from "@/lib/storage";

export const dynamic = "force-dynamic";

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
  if (!can(ctx.roles, "leads.manage") && !can(ctx.roles, "health.view")) {
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

  // DPDP audit trail: log every download.
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
