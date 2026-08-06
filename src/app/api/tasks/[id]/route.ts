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
    const task = await prisma.task.findUnique({ where: { id: params.id } });
    if (!task) throw new ApiError("NOT_FOUND", "Task not found", 404);

    const isOwner = task.assignedToSub === ctx.sub;
    if (!isOwner && !can(ctx.roles, "leads.manage")) {
      throw new ApiError("FORBIDDEN", "Not your task", 403);
    }

    const { status } = patchSchema.parse(await req.json());
    const updated = await prisma.task.update({
      where: { id: params.id },
      data: { status: status as TaskStatus },
    });
    return ok({ id: updated.id, status: updated.status });
  });
}
