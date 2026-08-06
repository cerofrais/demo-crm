import { NextRequest } from "next/server";
import { handle, ok, requireSession } from "@/lib/api";
import { readableDocCategories, can } from "@/lib/rbac";
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
    const scope = sp.get("scope"); // "general" = unattached library files
    if (guestId) where.guestId = guestId;
    if (enquiryId) where.enquiryId = enquiryId;
    if (category && allowed.includes(category as DocumentCategory)) {
      where.category = category as DocumentCategory;
    }
    if (scope === "general") {
      where.guestId = null;
      where.enquiryId = null;
    }

    // F40: lead-scoped callers (Reception AND read-only Staff) must not see
    // documents attached to guests/enquiries that aren't assigned to them.
    // Broad access is kept for leads.manage (Admin/Manager) and health.view
    // (Doctor's cross-guest clinical need). Shared library files (no guest +
    // no enquiry) stay visible to everyone.
    if (!can(ctx.roles, "leads.manage") && !can(ctx.roles, "health.view")) {
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
