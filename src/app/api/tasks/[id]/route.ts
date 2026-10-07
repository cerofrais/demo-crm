import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import type { TaskStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ status: z.enum(["open", "done", "cancelled"]) });

// PATCH /api/tasks/:id — mark a follow-up done/cancelled (owner or manager)
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    const task = await prisma.task.findUnique({
      where: { id: params.id },
      include: { enquiry: { select: { assignedToSub: true, guestId: true } } },
    });
    if (!task) throw new ApiError("NOT_FOUND", "Task not found", 404);

    // Whoever the task is assigned to, whoever owns the lead it sits on, or a
    // manager. The lead owner is here because they can now SEE these tasks
    // (see the list route) — a follow-up on your own lead that you can look at
    // but never tick off would be worse than not showing it at all.
    const isOwner = task.assignedToSub === ctx.sub;
    const ownsLead = task.enquiry.assignedToSub === ctx.sub;

    // A doctor_review task is a clinical gate, not a to-do: it is resolved by
    // the doctor recording their decision on the lead, never by ticking it
    // off here. Nothing in the UI changes one through this route — clearing a
    // review raised in error goes through DELETE below instead — so this is
    // admin-only (leads.delete), deliberately narrower than the owner/manager
    // rule the ordinary follow-ups use.
    if (task.kind === "doctor_review") {
      if (!can(ctx.roles, "leads.delete")) {
        throw new ApiError(
          "FORBIDDEN",
          "A doctor review is resolved by the doctor's decision on the lead. Only an admin can remove one.",
          403,
        );
      }
    } else if (!isOwner && !ownsLead && !can(ctx.roles, "leads.manage")) {
      throw new ApiError("FORBIDDEN", "Not your task", 403);
    }

    const { status } = patchSchema.parse(await req.json());
    const updated = await prisma.task.update({
      where: { id: params.id },
      data: { status: status as TaskStatus },
    });

    // Only log a real transition into done/cancelled — re-saving the same
    // status (or reopening) shouldn't spam the lead's activity feed. This is
    // what lets the Activity tab show a task as resolved instead of leaving
    // its "Added task" entry looking perpetually outstanding.
    if (task.status !== updated.status && (updated.status === "done" || updated.status === "cancelled")) {
      await prisma.activity.create({
        data: {
          enquiryId: task.enquiryId,
          guestId: task.enquiry.guestId,
          actorSub: ctx.sub,
          actorRole: ctx.roles[0] ?? "STAFF",
          actorName: ctx.name,
          actionType: updated.status === "done" ? "task_completed" : "task_cancelled",
          metadata: { taskId: task.id, title: task.title },
        },
      });
    }

    return ok({ id: updated.id, status: updated.status });
  });
}

/**
 * DELETE /api/tasks/:id — erase a task outright. Admin only (leads.delete).
 *
 * Exists for a task that should never have been raised — chiefly a duplicate
 * doctor review, or one on a lead that has since gone elsewhere. Cancelling
 * such a task leaves it in the completed list looking like a decision someone
 * made; erasing it is the honest outcome for something that was never a real
 * item of work.
 *
 * The lead is untouched: same stage, same owner, same history. An Activity
 * row is still written, and deliberately survives the task — it carries the
 * title and id in its metadata, so a doctor review that disappears from the
 * queue can still be accounted for afterwards. That row is the whole reason
 * this is a delete of the Task and not of the trail.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.delete")) {
      throw new ApiError("FORBIDDEN", "Only an admin can delete a task", 403);
    }

    const task = await prisma.task.findUnique({
      where: { id: params.id },
      include: { enquiry: { select: { guestId: true } } },
    });
    if (!task) throw new ApiError("NOT_FOUND", "Task not found", 404);

    // Written BEFORE the delete: if the delete fails there is no orphan entry
    // claiming a removal that never happened, and the row does not reference
    // the Task by foreign key, so it outlives it cleanly.
    await prisma.activity.create({
      data: {
        enquiryId: task.enquiryId,
        guestId: task.enquiry.guestId,
        actorSub: ctx.sub,
        actorRole: ctx.roles[0] ?? "STAFF",
        actorName: ctx.name,
        actionType: "task_deleted",
        metadata: { taskId: task.id, title: task.title, kind: task.kind },
      },
    });

    await prisma.task.delete({ where: { id: params.id } });

    return ok({ id: params.id, deleted: true });
  });
}
