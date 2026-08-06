import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can, canWorkLeadStage } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toEnquiryDTO, withCurrentAssigneeName } from "@/lib/enquiries";
import { addCustomTag, removeCustomTag } from "@/lib/tags-service";
import { tagMutationSchema } from "@/lib/validation";
import { withRnrProgress, withLostRequestPending } from "@/lib/tasks";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/enquiries/:id/tags — add or remove a custom tag on a lead.
 * Added tags are registered in the shared vocabulary so anyone can reuse them.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    const { add, remove } = tagMutationSchema.parse(await req.json());

    // F9: tag writes mutate the lead — gate on ownership, not bare leads.view,
    // so read-only STAFF and non-owning RECEPTION can't corrupt the record.
    const enquiry = await prisma.enquiry.findUnique({
      where: { id: params.id },
      select: { assignedToSub: true, stage: true },
    });
    if (!enquiry) throw new ApiError("NOT_FOUND", "Enquiry not found", 404);
    const allowed =
      can(ctx.roles, "leads.manage") ||
      (can(ctx.roles, "leads.ownOnly") &&
        enquiry.assignedToSub === ctx.sub &&
        canWorkLeadStage(ctx.roles, enquiry.stage));
    if (!allowed) throw new ApiError("FORBIDDEN", "Cannot edit tags on this lead", 403);

    if (add) await addCustomTag(params.id, add, ctx.sub);
    if (remove) await removeCustomTag(params.id, remove);

    const updated = await prisma.enquiry.findUnique({
      where: { id: params.id },
      include: { guest: true },
    });
    if (!updated) throw new ApiError("NOT_FOUND", "Enquiry not found", 404);
    return ok(await withLostRequestPending(await withRnrProgress(await withCurrentAssigneeName(toEnquiryDTO(updated)))));
  });
}
