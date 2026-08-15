import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { canMutateLeads, canWorkLeadStage } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { createTaskSchema } from "@/lib/validation";
import { HOUR, DAY } from "@/lib/tasks";

export const dynamic = "force-dynamic";

// POST /api/enquiries/:id/tasks — add a manual reminder task, due in N hours/days.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    const { title, amount, unit } = createTaskSchema.parse(await req.json());

    const enquiry = await prisma.enquiry.findUnique({ where: { id: params.id } });
    if (!enquiry) throw new ApiError("NOT_FOUND", "Enquiry not found", 404);

    // Same rule as remarks — anyone who actually works leads can leave a task
    // on it (not a bare read-only leads.view holder), still bounded by the
    // same stage-visibility rule as everything else.
    const allowed = canMutateLeads(ctx.roles) && canWorkLeadStage(ctx.roles, enquiry.stage);
    if (!allowed) throw new ApiError("FORBIDDEN", "Cannot add tasks to this lead", 403);

    // Lost/dead leads don't get worked further — no new tasks against them.
    if (enquiry.stage === "lost") {
      throw new ApiError("CONFLICT", "Cannot add tasks to a lost lead", 409);
    }

    const dueAt = new Date(Date.now() + amount * (unit === "hours" ? HOUR : DAY));

    const task = await prisma.task.create({
      data: {
        enquiryId: params.id,
        title,
        dueAt,
        // The lead's OWNER owns the follow-up, not whoever typed it. An Admin
        // or Manager adding a task on someone else's lead is asking that
        // person to do it — assigning it to the creator instead put the work
        // in the wrong queue and left the owner unaware of it.
        // Falls back to the creator when the lead is unassigned, so a task on
        // an orphan lead still belongs to somebody.
        assignedToSub: enquiry.assignedToSub ?? ctx.sub,
        // Who asked for it stays recorded, and the card shows it.
        createdBy: ctx.sub,
      },
    });

    await prisma.$transaction([
      prisma.activity.create({
        data: {
          enquiryId: params.id,
          guestId: enquiry.guestId,
          actorSub: ctx.sub,
          actorRole: ctx.roles[0] ?? "STAFF",
          actorName: ctx.name,
          actionType: "task_created",
          metadata: { taskId: task.id, title, dueAt: dueAt.toISOString() },
        },
      }),
      prisma.enquiry.update({
        where: { id: params.id },
        data: { lastActivityAt: new Date() },
      }),
    ]);

    return ok(
      { id: task.id, title: task.title, dueAt: task.dueAt?.toISOString() ?? null },
      undefined,
      201,
    );
  });
}
