import { NextRequest } from "next/server";
import { handle, ok, requireSession } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getStaffNamesBatch } from "@/lib/enquiries";
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
    // A task is created with assignedToSub = whoever created it, so a
    // follow-up an Admin/Manager adds on someone else's lead lands only in
    // the CREATOR's list. The person actually working that lead never saw it.
    // Owning the lead is therefore a second route to seeing its tasks,
    // alongside being the task's own assignee.
    // Lost/Dead requests are excluded on purpose: they're an Admin/Manager
    // decision queue, deliberately unassigned so any of them can pick one up,
    // and their card renders Approve/Deny buttons that the decision route
    // gates on leads.manage. Surfacing those to a lead owner who can't use
    // them would just be a pair of buttons that 403. Managers still get them
    // through their own clause below.
    const onMyLead: Prisma.TaskWhereInput = {
      enquiry: { assignedToSub: ctx.sub },
      kind: { not: "deletion_approval" },
    };

    // Managers/Admins may view all, or narrow to one staff member; everyone
    // else is restricted to their own tasks and their own leads' tasks.
    if (scope === "all" && can(ctx.roles, "reports.allStaff")) {
      if (assignee) where.assignedToSub = assignee;
    } else if (can(ctx.roles, "leads.manage")) {
      // Even in "my" scope, an Admin/Manager should see open Lost/Dead
      // requests without switching to "All staff" — they're unassigned by
      // design (any Admin/Manager can decide one), so a plain
      // assignedToSub=me filter would otherwise hide them from everyone's
      // default view.
      where.OR = [
        { assignedToSub: ctx.sub },
        { kind: "deletion_approval", assignedToSub: null },
        onMyLead,
      ];
    } else {
      where.OR = [{ assignedToSub: ctx.sub }, onMyLead];
    }
    if (status !== "all") where.status = status as TaskStatus;

    // Filters that describe the LEAD a task sits on, not the task itself —
    // which is how a rep actually thinks about a follow-up ("the RNR ones",
    // "the Instagram leads"). They're expressed against the enquiry relation
    // and AND-ed with the visibility clause above, never replacing it.
    const stage = sp.get("stage");
    const source = sp.get("source");
    const q = sp.get("q")?.trim();
    const leadWhere: Prisma.EnquiryWhereInput = {};
    if (stage) leadWhere.stage = stage as Prisma.EnquiryWhereInput["stage"];
    if (source) leadWhere.source = source as Prisma.EnquiryWhereInput["source"];
    if (q && q.length >= 2) {
      // Same shape and 2-char floor as the leads board's search — an
      // unindexed ILIKE '%a%' over every guest is not worth serving.
      leadWhere.guest = {
        OR: [
          { fullName: { contains: q.slice(0, 100), mode: "insensitive" } },
          { phone: { contains: q.slice(0, 100) } },
        ],
      };
    }
    if (Object.keys(leadWhere).length) where.enquiry = leadWhere;

    const tasks = await prisma.task.findMany({
      where,
      orderBy: [{ status: "asc" }, { dueAt: "asc" }],
      take: 200,
      include: {
        enquiry: {
          include: {
            guest: { select: { fullName: true, phone: true } },
            // The most recent remark on the lead — what a rep needs to know
            // before making the call, without opening the lead to find it.
            // take:1 per row, so this stays cheap on a 200-row page.
            notes: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { body: true, authorName: true, createdAt: true },
            },
          },
        },
      },
    });

    // A list that now mixes in other people's tasks has to say whose they
    // are, or the reader can't tell what they're expected to act on. The
    // creator matters too: a follow-up now lands in the LEAD OWNER's queue,
    // so "who asked me to do this" is only answerable from createdBy.
    const names = await getStaffNamesBatch([
      ...tasks.flatMap((t) => (t.assignedToSub ? [t.assignedToSub] : [])),
      ...tasks.map((t) => t.createdBy),
    ]);

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
        mine: t.assignedToSub === ctx.sub,
        assignedToName: t.assignedToSub ? (names.get(t.assignedToSub) ?? null) : null,
        // Only surfaced when someone else asked for it — a task you created
        // for yourself doesn't need "added by you" on the card.
        createdByName:
          t.createdBy && t.createdBy !== t.assignedToSub
            ? (names.get(t.createdBy) ?? null)
            : null,
        lastRemark: t.enquiry.notes[0]
          ? {
              // Trimmed here rather than in the client: the card shows one
              // line, and a 4KB remark on every row of a 200-row page is
              // payload nobody reads.
              body: t.enquiry.notes[0].body.slice(0, 300),
              authorName: t.enquiry.notes[0].authorName,
              createdAt: t.enquiry.notes[0].createdAt.toISOString(),
            }
          : null,
      })),
    );
  });
}
