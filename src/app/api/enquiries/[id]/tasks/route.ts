import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can, canMutateLeads, canViewLeadStage, canWorkLeadStage } from "@/lib/rbac";
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

    // Lost/dead leads don't get worked further — nor do non-leads, which were
    // never going to be. No new tasks against either.
    if (enquiry.stage === "lost" || enquiry.stage === "non_leads") {
      throw new ApiError(
        "CONFLICT",
        enquiry.stage === "lost"
          ? "Cannot add tasks to a lost lead"
          : "Cannot add tasks to a non-lead",
        409,
      );
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

// GET /api/enquiries/:id/tasks — the lead's open tasks, soonest due first.
// Read fresh by the drawer right before adding a task, so the "this lead
// already has tasks" check is accurate even if another rep added one since
// the card was loaded.
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view")) throw new ApiError("FORBIDDEN", "No access", 403);

    const enquiry = await prisma.enquiry.findUnique({
      where: { id: params.id },
      select: { stage: true },
    });
    if (!enquiry) throw new ApiError("NOT_FOUND", "Enquiry not found", 404);
    if (!canViewLeadStage(ctx.roles, enquiry.stage)) {
      throw new ApiError("FORBIDDEN", "No access to this lead", 403);
    }

    const tasks = await prisma.task.findMany({
      where: { enquiryId: params.id, status: "open" },
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
      select: { id: true, title: true, dueAt: true, kind: true },
    });
    return ok({
      items: tasks.map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt?.toISOString() ?? null, kind: t.kind })),
    });
  });
}
