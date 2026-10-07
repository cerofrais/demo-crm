import { NextRequest } from "next/server";
import { handle, ok, requireSession } from "@/lib/api";
import { readableDocCategories, can, canReadAllGuestData } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { isInlineType } from "@/lib/storage";
import type { DocumentCategory, Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

// GET /api/files?guestId=&enquiryId=&category= — list document metadata
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    const sp = req.nextUrl.searchParams;
    const allowed = readableDocCategories(ctx.roles) as DocumentCategory[];

    const where: Prisma.DocumentWhereInput = {
      category: { in: allowed },
    };
    const guestId = sp.get("guestId");
    const enquiryId = sp.get("enquiryId");
    const category = sp.get("category");
    // "general"    = unattached library files only
    // "attachable" = what a message composer may attach: the shared library
    //                PLUS this guest's own documents, in one list. Matches
    //                findAttachableDocument()'s rule on the send routes, so
    //                the picker can't offer something the send would refuse.
    const scope = sp.get("scope");
    if (scope !== "attachable") {
      if (guestId) where.guestId = guestId;
      if (enquiryId) where.enquiryId = enquiryId;
    }
    if (category && allowed.includes(category as DocumentCategory)) {
      where.category = category as DocumentCategory;
    }
    if (scope === "general") {
      where.guestId = null;
      where.enquiryId = null;
    } else if (scope === "attachable") {
      // AND, not OR: the permission narrowing below owns `where.OR`, and
      // assigning it here would silently replace that filter.
      where.AND = [
        {
          OR: [
            { guestId: null, enquiryId: null },
            ...(guestId ? [{ guestId }] : []),
          ],
        },
      ];
    }

    // Identity lookup for the composer's attachment picker: "is this exact
    // file already here?" Matched on filename + size + type, which is what
    // the browser knows about a picked File without reading its bytes.
    // Needed as a server-side filter rather than a scan of the list above,
    // because that list is capped at 200 rows and a library past that cap
    // would silently re-upload duplicates.
    const filename = sp.get("filename");
    const sizeBytes = sp.get("sizeBytes");
    const mimeType = sp.get("mimeType");
    if (filename) where.filename = filename;
    if (sizeBytes && Number.isFinite(Number(sizeBytes))) where.sizeBytes = Number(sizeBytes);
    if (mimeType) where.mimeType = mimeType;

    // F40: lead-scoped callers (Reception AND read-only Staff) must not see
    // documents attached to guests/enquiries that aren't assigned to them.
    // Broad access is kept for leads.manage (Admin/Manager) and health.view
    // (Doctor's cross-guest clinical need). Shared library files (no guest +
    // no enquiry) stay visible to everyone.
    if (!canReadAllGuestData(ctx.roles)) {
      where.OR = [
        { guestId: null, enquiryId: null },
        { enquiry: { assignedToSub: ctx.sub } },
        { guest: { enquiries: { some: { assignedToSub: ctx.sub } } } },
      ];
    }

    const docs = await prisma.document.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return ok(
      docs.map((d) => ({
        id: d.id,
        filename: d.filename,
        mimeType: d.mimeType,
        category: d.category,
        sizeBytes: d.sizeBytes,
        guestId: d.guestId,
        enquiryId: d.enquiryId,
        inline: isInlineType(d.mimeType),
        createdAt: d.createdAt.toISOString(),
      })),
    );
  });
}
