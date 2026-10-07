import { prisma } from "./prisma";

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

/**
 * Stable prefix on the 3 auto-generated RNR cadence task titles — lets us
 * tell them apart from manually-added tasks (see addManualTask) when
 * checking "is the cadence already scheduled" or counting RNR progress.
 */
export const RNR_TASK_PREFIX = "Follow-up call (";
export const RNR_TASK_TOTAL = 3;

/**
 * The sales-flow "6-2-1" follow-up cadence:
 *   call within 6 hours · 2nd follow-up after 2 days · 3rd after 1 week.
 * Created when a lead enters RNR (Responded Not Reached). No-ops if the
 * cadence is already scheduled and still open, so re-entering RNR won't pile
 * up duplicates — scoped to cadence-titled tasks so it doesn't get blocked
 * by an unrelated manually-added task still being open.
 */
export async function createFollowUpTasks(
  enquiryId: string,
  ownerSub: string,
): Promise<void> {
  const existing = await prisma.task.count({
    where: { enquiryId, status: "open", title: { startsWith: RNR_TASK_PREFIX } },
  });
  if (existing > 0) return;

  const now = Date.now();
  const schedule = [
    { title: `${RNR_TASK_PREFIX}1/3) — within 6 hours`, at: now + 6 * HOUR },
    { title: `${RNR_TASK_PREFIX}2/3) — after 2 days`, at: now + 2 * DAY },
    { title: `${RNR_TASK_PREFIX}3/3) — after 1 week`, at: now + 7 * DAY },
  ];

  await prisma.task.createMany({
    data: schedule.map((s) => ({
      enquiryId,
      title: s.title,
      dueAt: new Date(s.at),
      assignedToSub: ownerSub,
      createdBy: ownerSub,
    })),
  });

  await prisma.enquiry.update({
    where: { id: enquiryId },
    data: { needsAttention: true },
  }).catch(() => null);
}

export interface RnrProgress {
  done: number;
  total: number;
}

/** How many of the 3 RNR cadence tasks are done, for a lead currently in RNR. */
export async function getRnrProgress(
  enquiryId: string,
  stage: string,
): Promise<RnrProgress | null> {
  if (stage !== "rnr") return null;
  const rows = await prisma.task.groupBy({
    by: ["status"],
    where: { enquiryId, title: { startsWith: RNR_TASK_PREFIX } },
    _count: true,
  });
  const total = rows.reduce((sum, r) => sum + r._count, 0);
  if (total === 0) return null;
  const done = rows.find((r) => r.status === "done")?._count ?? 0;
  return { done, total };
}

/** Batch version of getRnrProgress for list responses — one query, not N+1. */
export async function getRnrProgressBatch(
  rnrEnquiryIds: string[],
): Promise<Map<string, RnrProgress>> {
  if (!rnrEnquiryIds.length) return new Map();
  const rows = await prisma.task.groupBy({
    by: ["enquiryId", "status"],
    where: { enquiryId: { in: rnrEnquiryIds }, title: { startsWith: RNR_TASK_PREFIX } },
    _count: true,
  });
  const map = new Map<string, RnrProgress>();
  for (const r of rows) {
    const cur = map.get(r.enquiryId) ?? { done: 0, total: 0 };
    cur.total += r._count;
    if (r.status === "done") cur.done += r._count;
    map.set(r.enquiryId, cur);
  }
  return map;
}

/** Attaches rnrProgress to a single already-built EnquiryDTO-shaped object. */
export async function withRnrProgress<T extends { id: string; stage: string }>(
  dto: T,
): Promise<T & { rnrProgress: RnrProgress | null }> {
  return { ...dto, rnrProgress: await getRnrProgress(dto.id, dto.stage) };
}

/** Attaches lostRequestPending to a single already-built EnquiryDTO-shaped object. */
export async function withLostRequestPending<T extends { id: string }>(
  dto: T,
): Promise<T & { lostRequestPending: boolean }> {
  return { ...dto, lostRequestPending: await hasOpenDeletionApprovalTask(dto.id) };
}

/**
 * A call to an RNR lead actually connected — mark the earliest open cadence
 * task done, so the "1/3 → 2/3" progress advances without a rep having to
 * check it off by hand. No-ops if the lead has left RNR or none of the
 * cadence tasks are still open (e.g. this call is a duplicate webhook
 * delivery for a call already accounted for).
 */
export async function completeNextRnrTask(enquiryId: string): Promise<void> {
  const enquiry = await prisma.enquiry.findUnique({
    where: { id: enquiryId },
    select: { stage: true },
  });
  if (!enquiry || enquiry.stage !== "rnr") return;

  const next = await prisma.task.findFirst({
    where: { enquiryId, status: "open", title: { startsWith: RNR_TASK_PREFIX } },
    orderBy: { dueAt: "asc" },
  });
  if (!next) return;

  await prisma.task.update({ where: { id: next.id }, data: { status: "done" } });
}

/**
 * Keep still-open follow-up tasks in sync with who currently owns the
 * ticket — reassigning a lead (manually, via drag-to-claim, or the
 * auto-unassign at Booking Confirmed) moves its open cadence/manual tasks
 * to the new owner too, rather than leaving them pinned to whoever the
 * lead was assigned to when the task was created. Done/cancelled tasks are
 * historical record and are left alone.
 */
export async function reassignTasksForEnquiry(
  enquiryId: string,
  assignedToSub: string | null,
): Promise<void> {
  // Doctor-review tasks are owned by "the review process," not the working
  // rep — a lead reassignment shouldn't sweep them up.
  await prisma.task.updateMany({
    where: { enquiryId, status: "open", kind: "follow_up" },
    data: { assignedToSub },
  });
}

/**
 * Lost/dead leads don't get worked any further, so any open or scheduled
 * follow-up tasks against them (RNR cadence, manual reminders) are just
 * noise — clear them out when a lead actually enters "lost" (i.e. when a
 * deletion-approval request is approved). Notes/Activity/Calls history is
 * left alone; this only touches Task rows. Deletion-approval tasks are
 * excluded — the just-decided one is the audit record of this exact
 * transition and stays as history (see the decision route).
 */
export async function deleteTasksForEnquiry(enquiryId: string): Promise<void> {
  await prisma.task.deleteMany({ where: { enquiryId, kind: { not: "deletion_approval" } } });
}

export const DELETION_APPROVAL_TITLE_PREFIX = "Approve deletion: ";

/**
 * A rep/doctor/manager requested a lead be marked Lost/Dead — creates one
 * unassigned task any Admin/Manager can approve or deny (surfaces in Tasks
 * -> All staff). The stage does NOT change here; it only changes if/when an
 * Admin/Manager approves (see PATCH /api/tasks/:id/decision) — this call
 * just opens the request. Idempotent, same pattern as createFollowUpTasks —
 * re-requesting while one is already open is a no-op.
 */
export async function createDeletionApprovalTask(
  enquiryId: string,
  guestName: string,
  createdBySub: string,
): Promise<void> {
  const existing = await prisma.task.count({
    where: { enquiryId, status: "open", kind: "deletion_approval" },
  });
  if (existing > 0) return;

  await prisma.task.create({
    data: {
      enquiryId,
      title: `${DELETION_APPROVAL_TITLE_PREFIX}${guestName}`,
      kind: "deletion_approval",
      assignedToSub: null,
      createdBy: createdBySub,
    },
  });
}

/** Whether this lead already has an open (undecided) Lost/Dead request. */
export async function hasOpenDeletionApprovalTask(enquiryId: string): Promise<boolean> {
  const count = await prisma.task.count({
    where: { enquiryId, status: "open", kind: "deletion_approval" },
  });
  return count > 0;
}

/** Batch version of hasOpenDeletionApprovalTask for list responses — one query, not N+1. */
export async function getLostRequestPendingBatch(enquiryIds: string[]): Promise<Set<string>> {
  if (!enquiryIds.length) return new Set();
  const rows = await prisma.task.findMany({
    where: { enquiryId: { in: enquiryIds }, status: "open", kind: "deletion_approval" },
    select: { enquiryId: true },
  });
  return new Set(rows.map((r) => r.enquiryId));
}

export const DOCTOR_REVIEW_TITLE_PREFIX = "Review consultation: ";

/**
 * Lead entered Doctor Consultation — one unassigned task any doctor can
 * pick up (there's no per-doctor assignment concept — see rbac.ts). Doctor
 * can't reach the "All staff" Tasks view (no reports.allStaff), so their
 * actual discovery surface is the Kanban card badge + lead-drawer decision
 * banner; this task exists mainly for audit/consistency and so Admin/Manager
 * can also see it. Idempotent, same pattern as createFollowUpTasks.
 */
export async function createDoctorReviewTask(
  enquiryId: string,
  guestName: string,
  createdBySub: string,
): Promise<void> {
  const existing = await prisma.task.count({
    where: { enquiryId, status: "open", kind: "doctor_review" },
  });
  if (existing > 0) return;

  await prisma.task.create({
    data: {
      enquiryId,
      title: `${DOCTOR_REVIEW_TITLE_PREFIX}${guestName}`,
      kind: "doctor_review",
      assignedToSub: null,
      createdBy: createdBySub,
    },
  });
}

export const PAYMENT_PENDING_TITLE_PREFIX = "Chase payment: ";

/**
 * 08:00 IST, today if it is still to come and tomorrow otherwise.
 *
 * IST is UTC+5:30 with no daylight saving, so 08:00 IST is 02:30 UTC on the
 * same calendar day — computed directly rather than through a local-time
 * constructor, which would read the SERVER's timezone and put the reminder at
 * 08:00 UTC (13:30 IST, well past the morning it is meant for).
 */
export function nextEightAmIst(now: Date = new Date()): Date {
  const target = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 30, 0, 0),
  );
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return target;
}

/**
 * The standing chase on a lead sitting in Payment Pending.
 *
 * One open task per lead, owned by whoever owns the lead, due at 08:00 IST.
 * It is not a cadence and does not repeat: it stays open — and sorts to the
 * top of the Tasks list — until the lead leaves the stage, at which point
 * closePaymentPendingTasks resolves it. The point is that a lead waiting on
 * money is visible every morning without anybody scheduling anything.
 *
 * Idempotent, like the other system tasks: re-entering the stage while one is
 * already open is a no-op rather than a second chase.
 *
 * An unassigned lead gets an unassigned task, which is how it surfaces in
 * Tasks -> All staff for a manager to pick up, rather than being invented an
 * owner it does not have.
 */
export async function createPaymentPendingTask(
  enquiryId: string,
  guestName: string,
  ownerSub: string | null,
  createdBySub: string,
): Promise<void> {
  const existing = await prisma.task.count({
    where: { enquiryId, status: "open", kind: "payment_pending" },
  });
  if (existing > 0) return;

  await prisma.task.create({
    data: {
      enquiryId,
      title: `${PAYMENT_PENDING_TITLE_PREFIX}${guestName}`,
      kind: "payment_pending",
      dueAt: nextEightAmIst(),
      assignedToSub: ownerSub,
      createdBy: createdBySub,
    },
  });
}

/**
 * Close the chase when the lead leaves Payment Pending — whether it moved
 * forward to Booking Confirmed or backwards. Marked done rather than deleted
 * so the lead's timeline keeps the task_completed entry PATCH would have
 * written by hand.
 *
 * Returns how many were closed, so the caller can skip writing an activity
 * row when there was nothing to close.
 */
export async function closePaymentPendingTasks(enquiryId: string): Promise<number> {
  const { count } = await prisma.task.updateMany({
    where: { enquiryId, status: "open", kind: "payment_pending" },
    data: { status: "done" },
  });
  return count;
}

/** How many of a lead's open tasks travel with it for the card's hover list. */
export const OPEN_TASK_PREVIEW = 5;

export interface OpenTasksSummary {
  /** Every open task on the lead, not just the previewed ones. */
  count: number;
  /** The soonest-due few, for the card's hover list. */
  items: { id: string; title: string; dueAt: string | null; kind: string }[];
}

/**
 * Open tasks for many leads in one query — the board shows this on every
 * card, so it is batched the same way RNR progress and the WhatsApp window
 * are. Soonest due first; a task with no due date sorts last.
 */
export async function getOpenTasksBatch(enquiryIds: string[]): Promise<Map<string, OpenTasksSummary>> {
  const out = new Map<string, OpenTasksSummary>();
  if (!enquiryIds.length) return out;
  const rows = await prisma.task.findMany({
    where: { enquiryId: { in: enquiryIds }, status: "open" },
    orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
    select: { id: true, enquiryId: true, title: true, dueAt: true, kind: true },
  });
  for (const r of rows) {
    const summary = out.get(r.enquiryId) ?? { count: 0, items: [] };
    summary.count += 1;
    if (summary.items.length < OPEN_TASK_PREVIEW) {
      summary.items.push({ id: r.id, title: r.title, dueAt: r.dueAt?.toISOString() ?? null, kind: r.kind });
    }
    out.set(r.enquiryId, summary);
  }
  return out;
}

/**
 * Attaches the open-task summary to one already-built lead.
 *
 * Needed on every route that hands a single lead back to the board, not just
 * the board list: the board replaces a card with whatever a save returns, so a
 * lead returned without this would lose its task icon after any edit.
 */
export async function withOpenTasks<T extends { id: string }>(
  dto: T,
): Promise<T & { openTasks: OpenTasksSummary }> {
  const byId = await getOpenTasksBatch([dto.id]);
  return { ...dto, openTasks: byId.get(dto.id) ?? { count: 0, items: [] } };
}
