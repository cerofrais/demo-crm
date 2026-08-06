import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { canMutateLeads, canWorkLeadStage } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { createDeletionApprovalTask, withRnrProgress, withLostRequestPending } from "@/lib/tasks";
import { toEnquiryDTO, withCurrentAssigneeName } from "@/lib/enquiries";

export const dynamic = "force-dynamic";

/**
 * POST /api/enquiries/:id/request-lost — ask an Admin/Manager to mark this
 * lead Lost/Dead. Doesn't change the stage itself — only PATCH
 * /api/tasks/:id/decision (approving the resulting task) does that. Anyone
 * who can already work this lead can request it, including Admin/Manager
 * themselves (who can also approve their own request — see the decision
 * route); this is now the ONLY path to Lost/Dead for every role, replacing
 * the direct drag/edit move.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    const current = await prisma.enquiry.findUnique({ where: { id: params.id }, include: { guest: true } });
    if (!current || current.deletedAt) throw new ApiError("NOT_FOUND", "Enquiry not found", 404);

    const allowed = canMutateLeads(ctx.roles) && canWorkLeadStage(ctx.roles, current.stage);
    if (!allowed) throw new ApiError("FORBIDDEN", "Cannot request this lead be marked Lost/Dead", 403);

    if (current.stage === "lost") {
      throw new ApiError("BAD_REQUEST", "Lead is already Lost/Dead", 400);
    }

    await createDeletionApprovalTask(current.id, current.guest.fullName, ctx.sub);

    await prisma.activity.create({
      data: {
        enquiryId: current.id,
        guestId: current.guestId,
        actorSub: ctx.sub,
        actorRole: ctx.roles[0] ?? "STAFF",
        actorName: ctx.name,
        actionType: "lost_requested",
        metadata: {},
      },
    });

    return ok(await withLostRequestPending(await withRnrProgress(await withCurrentAssigneeName(toEnquiryDTO(current)))));
  });
}
