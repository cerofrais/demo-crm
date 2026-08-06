import { NextRequest } from "next/server";
import { handle, ok, requireSession } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import type { Prisma, TaskStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

// GET /api/tasks?scope=me|all&status=open|all — follow-ups / reminders
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    const sp = req.nextUrl.searchParams;
    const scope = sp.get("scope") ?? "me";
    const status = sp.get("status") ?? "open";
    const assignee = sp.get("assignee");

    const where: Prisma.TaskWhereInput = {};
    // Managers/Admins may view all, or narrow to one staff member; everyone
    // else is restricted to their own.
    if (scope === "all" && can(ctx.roles, "reports.allStaff")) {
      if (assignee) where.assignedToSub = assignee;
    } else if (can(ctx.roles, "leads.manage")) {
      // Even in "my" scope, an Admin/Manager should see open Lost/Dead
      // requests without switching to "All staff" — they're unassigned by
      // design (any Admin/Manager can decide one), so a plain
      // assignedToSub=me filter would otherwise hide them from everyone's
      // default view.
      where.OR = [{ assignedToSub: ctx.sub }, { kind: "deletion_approval", assignedToSub: null }];
    } else {
      where.assignedToSub = ctx.sub;
    }
    if (status !== "all") where.status = status as TaskStatus;

    const tasks = await prisma.task.findMany({
      where,
      orderBy: [{ status: "asc" }, { dueAt: "asc" }],
      take: 200,
      include: { enquiry: { include: { guest: { select: { fullName: true, phone: true } } } } },
    });

    const now = Date.now();
    return ok(
      tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        kind: t.kind,
        approved: t.approved,
        dueAt: t.dueAt?.toISOString() ?? null,
        overdue: t.status === "open" && t.dueAt ? t.dueAt.getTime() < now : false,
        enquiryId: t.enquiryId,
        guestName: t.enquiry.guest.fullName,
        guestPhone: t.enquiry.guest.phone,
        stage: t.enquiry.stage,
      })),
    );
  });
}
