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
    if (!isOwner && !ownsLead && !can(ctx.roles, "leads.manage")) {
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
