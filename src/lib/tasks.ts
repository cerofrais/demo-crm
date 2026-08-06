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
