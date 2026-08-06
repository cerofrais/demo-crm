import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { deleteTasksForEnquiry } from "@/lib/tasks";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ approved: z.boolean(), reason: z.string().max(500).optional() });

/**
 * PATCH /api/tasks/:id/decision — approve or deny a Lost/Dead request.
 * Admin/Manager only (leads.manage) — including the same person who
 * requested it, if they hold that permission themselves; there's no
 * self-approval block. Approving is what actually moves the lead to "lost"
 * (stamping Enquiry.lostAt, which the auto-delete sweep counts
 * LeadDeletionSettings.autoDeleteDays from) and clears its other open tasks.
 * Denying just marks the request decided; the lead's stage is untouched.
 * Either way the task leaves the open queue for every Admin/Manager at once.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requirePermission("leads.manage");
    const task = await prisma.task.findUnique({
      where: { id: params.id },
      include: { enquiry: { select: { guestId: true, stage: true } } },
    });
    if (!task) throw new ApiError("NOT_FOUND", "Task not found", 404);
    if (task.kind !== "deletion_approval") {
      throw new ApiError("BAD_REQUEST", "Not a Lost/Dead request", 400);
    }
    if (task.status !== "open") {
      throw new ApiError("BAD_REQUEST", "This request has already been decided", 400);
    }

    const { approved, reason } = patchSchema.parse(await req.json());

    await prisma.task.update({
      where: { id: task.id },
      data: { status: "done", approved },
    });

    if (approved) {
      await prisma.enquiry.update({
        where: { id: task.enquiryId },
        data: { stage: "lost", lostAt: new Date(), lastActivityAt: new Date() },
      });
      await deleteTasksForEnquiry(task.enquiryId);
      await prisma.activity.create({
        data: {
          enquiryId: task.enquiryId,
          guestId: task.enquiry.guestId,
          actorSub: ctx.sub,
          actorRole: ctx.roles[0] ?? "STAFF",
          actorName: ctx.name,
          actionType: "stage_change",
          metadata: { from: task.enquiry.stage, to: "lost" },
        },
      });
    }

    await prisma.activity.create({
      data: {
        enquiryId: task.enquiryId,
        guestId: task.enquiry.guestId,
        actorSub: ctx.sub,
        actorRole: ctx.roles[0] ?? "STAFF",
        actorName: ctx.name,
        actionType: "deletion_decision",
        metadata: { approved, reason: reason ?? null },
      },
    });

    return ok({ id: task.id, status: "done", approved });
  });
}
