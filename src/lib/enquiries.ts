import { z } from "zod";
import type { Enquiry, Guest, Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { ageFromDob, ageGroup } from "./utils";
import { mergeLeadTags, slugifyTag, sortTags } from "./lead-tags";
import { getRnrProgressBatch, getLostRequestPendingBatch, hasOpenDeletionApprovalTask } from "./tasks";
import { PHONE_RE } from "./validation";
import { STAGES } from "./kanban";
import { can, canWorkLeadStage, type AppRole } from "./rbac";
import type { EnquiryDTO, AssistResultDTO } from "./types";

type EnquiryWithGuest = Enquiry & { guest: Guest };

export function toEnquiryDTO(e: EnquiryWithGuest): EnquiryDTO {
  return {
    id: e.id,
    stage: e.stage,
    source: e.source,
    assignedToSub: e.assignedToSub,
    assignedToName: e.assignedToName,
    isReturningFlag: e.isReturningFlag,
    quotedPriceINR: e.quotedPriceINR,
    campaignLabel: e.campaignLabel,
    intakeNotes: e.intakeNotes,
    // Date-only in meaning (see parseFormDate) — the client renders just the
    // calendar date, never a time.
    preferredCheckIn: e.preferredCheckIn?.toISOString() ?? null,
    boardPosition: e.boardPosition,
    needsAttention: e.needsAttention,
    aiScore: e.aiScore,
    aiScoreReason: e.aiScoreReason,
    aiAssist: (e.aiAssist as AssistResultDTO | null) ?? null,
    aiAssistAt: e.aiAssistAt?.toISOString() ?? null,
    // merged on read so even un-synced leads show current system tags
    tags: mergeLeadTags(e.tags, e.guest, e),
    lastActivityAt: e.lastActivityAt.toISOString(),
    createdAt: e.createdAt.toISOString(),
    rnrProgress: null,
    doctorDecision: e.doctorDecision,
    doctorDecisionAt: e.doctorDecisionAt?.toISOString() ?? null,
    doctorDecisionNote: e.doctorDecisionNote,
    lostRequestPending: false,
    guest: {
      id: e.guest.id,
      fullName: e.guest.fullName,
      phone: e.guest.phone,
      email: e.guest.email,
      city: e.guest.city,
      gender: e.guest.gender,
      ageGroup: ageGroup(ageFromDob(e.guest.dateOfBirth)),
      isReturning: e.guest.isReturning,
      tags: e.guest.tags,
    },
  };
}

export interface EnquiryFilters {
  q?: string;
  stage?: string;
  source?: string;
  assignee?: string; // sub or "me" handled by caller
  gender?: string;
  city?: string;
  tag?: string;
  /** Filter by Enquiry.createdAt, inclusive. YYYY-MM-DD (from a date input). */
  createdFrom?: string;
  createdTo?: string;
  /**
   * RNR follow-up completion: "none" | "partial" | "all" | "open".
   * See matchesRnrFilter. Only RNR-stage leads have this, so setting it
   * implies stage=rnr.
   *
   * Applied AFTER the query, not in the where-clause: the count is derived
   * from Task rows, not stored on Enquiry, so there's nothing to filter on in
   * SQL. That also means it can never drift out of sync with the tasks —
   * marking a follow-up done immediately moves the lead between buckets.
   */
  rnrDone?: string;
}

/** Build a Prisma where-clause from filter params (spec §6.2). */
export function buildWhere(f: EnquiryFilters): Prisma.EnquiryWhereInput {
  const where: Prisma.EnquiryWhereInput = { deletedAt: null };
  const guest: Prisma.GuestWhereInput = { deletedAt: null };

  if (f.stage) where.stage = f.stage as Prisma.EnquiryWhereInput["stage"];
  if (f.source) where.source = f.source as Prisma.EnquiryWhereInput["source"];
  if (f.assignee) where.assignedToSub = f.assignee;
  if (f.gender) guest.gender = f.gender;
  if (f.city) guest.city = { contains: f.city, mode: "insensitive" };
  if (f.tag) guest.tags = { has: f.tag };
  if (f.createdFrom || f.createdTo) {
    // A bare "YYYY-MM-DD" (from just the date picker) defaults to the start/
    // end of that day; "YYYY-MM-DDTHH:MM" (date + time picker both set) is
    // used as the exact instant instead.
    where.createdAt = {
      ...(f.createdFrom && {
        gte: f.createdFrom.includes("T") ? new Date(f.createdFrom) : new Date(`${f.createdFrom}T00:00:00`),
      }),
      // end-of-day so a date-only "to" is inclusive of the whole selected date.
      ...(f.createdTo && {
        lte: f.createdTo.includes("T") ? new Date(f.createdTo) : new Date(`${f.createdTo}T23:59:59.999`),
      }),
    };
  }

  if (f.q) {
    // F44: guard against trivial DoS via unindexed ILIKE '%…%' scans.
    //  - ignore <2-char queries (too broad to index, matches ~everything)
    //  - cap length at 100 to bound the pattern
    //  - drop the notes-body join from the default path (unindexed join = worst offender)
    const q = f.q.trim().slice(0, 100);
    if (q.length >= 2) {
      where.OR = [
        { guest: { fullName: { contains: q, mode: "insensitive" } } },
        { guest: { phone: { contains: q } } },
        { guest: { email: { contains: q, mode: "insensitive" } } },
        { campaignLabel: { contains: q, mode: "insensitive" } },
      ];
    }
  }

  where.guest = { ...guest };
  return where;
}

/**
 * How many leads are flagged as needing attention for THIS user — the same
 * amber dot the board shows on a card, totalled for the notification badge.
 *
 * Deliberately mirrors the visibility rules /api/enquiries applies to the
 * list, so the badge can never promise a lead the board won't show: the same
 * soft-delete and guest filters, the same own/unassigned narrowing for
 * leads.ownOnly roles, and the same stage boundaries (Sales past Booking
 * Confirmed, Doctor outside consultation, Staff-only stages). Those are
 * resolved to a stage list up front and pushed into SQL, so this stays one
 * indexed COUNT rather than the 500-row fetch the list route does — it is
 * polled on a timer by every signed-in user.
 */
function attentionWhere(roles: AppRole[], sub: string): Prisma.EnquiryWhereInput | null {
  const stages = STAGES.filter((s) => canWorkLeadStage(roles, s.id)).map((s) => s.id);
  if (!stages.length) return null;

  const where: Prisma.EnquiryWhereInput = {
    deletedAt: null,
    needsAttention: true,
    guest: { deletedAt: null },
    stage: { in: stages },
  };
  // Reception/Sales see their own plus the unassigned queue they can pick from.
  if (!can(roles, "leads.manage") && can(roles, "leads.ownOnly")) {
    where.OR = [{ assignedToSub: sub }, { assignedToSub: null }];
  }
  return where;
}

export async function countLeadsNeedingAttention(
  roles: AppRole[],
  sub: string,
): Promise<number> {
  const where = attentionWhere(roles, sub);
  if (!where) return 0;
  return prisma.enquiry.count({ where });
}

/**
 * Mark a lead as freshly active, so it rises to the top of its board column.
 *
 * Within a column the board orders by lastActivityAt descending (boardPosition
 * is 0 on every row — nothing has ever written a different value), so this is
 * the single lever that moves a card up. Inbound messages, notes and stage
 * changes already set it inline; this exists for the paths that update a lead
 * without touching it directly — an outbound message, a finished call.
 *
 * Never throws: a card sorting a place lower is not worth failing a send or a
 * call webhook over.
 */
export async function touchLead(enquiryId: string | null | undefined): Promise<void> {
  if (!enquiryId) return;
  await prisma.enquiry
    .update({ where: { id: enquiryId }, data: { lastActivityAt: new Date() } })
    .catch(() => null);
}

export interface AttentionItemDTO {
  enquiryId: string;
  guestName: string;
  stage: string;
  lastActivityAt: string;
  /** What actually needs looking at — the newest inbound message on the lead. */
  message: {
    channel: string;
    preview: string;
    createdAt: string;
    subject: string | null;
  } | null;
  /** Fallback when no message flagged it: the newest open follow-up. Scheduling
   *  RNR calls also sets needsAttention, and on production that is most of the
   *  list — without this those rows would read "needs a look" and say nothing. */
  task: { title: string; dueAt: string | null } | null;
}

/**
 * The leads behind the notification badge, newest first, so the badge can open
 * into "what needs me" rather than only saying how many.
 *
 * Each item carries the newest INBOUND message on the lead — that is the thing
 * that flipped needsAttention (see the WhatsApp webhook and inbound-mail), so
 * it is both the preview to show and what tells the client which channel tab
 * to open. A lead flagged by something other than a message (a new task) has
 * no message and just opens on the lead.
 */
export async function listLeadsNeedingAttention(
  roles: AppRole[],
  sub: string,
  limit = 15,
): Promise<{ items: AttentionItemDTO[]; total: number }> {
  // Bounded so "Show more" can't be used to page through the whole board one
  // dropdown at a time — past this the board itself is the right surface.
  limit = Math.min(Math.max(limit, 1), 60);
  const where = attentionWhere(roles, sub);
  if (!where) return { items: [], total: 0 };

  const [total, rows] = await Promise.all([
    prisma.enquiry.count({ where }),
    prisma.enquiry.findMany({
      where,
      orderBy: { lastActivityAt: "desc" },
      take: limit,
      select: {
        id: true,
        stage: true,
        lastActivityAt: true,
        guestId: true,
        guest: { select: { fullName: true } },
      },
    }),
  ]);

  // One query for the whole page rather than one per lead. Email threads are
  // guest-level (enquiryId is null on them), so this matches on guestId — the
  // reason it can't just be an include on the enquiry.
  const messages = await prisma.message.findMany({
    where: { guestId: { in: rows.map((r) => r.guestId) }, direction: "inbound" },
    orderBy: [{ guestId: "asc" }, { createdAt: "desc" }],
    distinct: ["guestId"],
    select: { guestId: true, channel: true, body: true, subject: true, createdAt: true },
  });
  const byGuest = new Map(messages.map((m) => [m.guestId!, m]));

  // Same batched shape for the task fallback.
  const tasks = await prisma.task.findMany({
    where: { enquiryId: { in: rows.map((r) => r.id) }, status: "open" },
    orderBy: [{ enquiryId: "asc" }, { dueAt: "asc" }],
    distinct: ["enquiryId"],
    select: { enquiryId: true, title: true, dueAt: true },
  });
  const byEnquiry = new Map(tasks.map((t) => [t.enquiryId, t]));

  return {
    total,
    items: rows.map((r) => {
      const m = byGuest.get(r.guestId);
      const t = byEnquiry.get(r.id);
      return {
        enquiryId: r.id,
        guestName: r.guest.fullName,
        stage: r.stage,
        lastActivityAt: r.lastActivityAt.toISOString(),
        message: m
          ? {
              channel: m.channel,
              // Trimmed here: the dropdown shows two lines, and a full email
              // body per row would dominate a response polled on a timer.
              preview: m.body.replace(/\s+/g, " ").trim().slice(0, 160),
              subject: m.subject,
              createdAt: m.createdAt.toISOString(),
            }
          : null,
        task: t ? { title: t.title, dueAt: t.dueAt?.toISOString() ?? null } : null,
      };
    }),
  };
}

/**
 * Ceiling on one board load.
 *
 * The board fetches every lead in one go and re-fetches the lot on its
 * auto-refresh timer, so the cost that matters is payload × clients × refresh
 * rate, not query time. Measured on production: ~1.1KB per lead, so 500 leads
 * is ~560KB and 266ms — which projects to ~1.1MB per refresh at 1,000 leads
 * and ~5.5MB at 5,000.
 *
 * It was 500 from the first commit with no comment, and production quietly
 * grew past it: 518 live leads meant 18 were silently dropped off the end.
 * Because the sort is stage-first, they all landed in the last stage —
 * "staff" — so an Admin's Staff column was short and nobody else could see
 * that stage anyway, which is why it went unnoticed.
 *
 * 2,000 is chosen to be far enough above today's 518 that nothing truncates
 * for years at the current rate, while still bounding a runaway response.
 * Past that the fix is per-column pagination, not a bigger number — see the
 * warning logged below, which exists so this can never go silent again.
 */
export const BOARD_LEAD_CAP = 2000;

export async function listEnquiries(f: EnquiryFilters): Promise<EnquiryDTO[]> {
  const rows = await prisma.enquiry.findMany({
    // An RNR-progress filter only has meaning for RNR-stage leads, and
    // narrowing here (rather than after) keeps the 500-row cap from being
    // spent on leads the filter would discard anyway.
    where: buildWhere(f.rnrDone ? { ...f, stage: "rnr" } : f),
    include: { guest: true },
    orderBy: [{ stage: "asc" }, { boardPosition: "asc" }, { lastActivityAt: "desc" }],
    take: BOARD_LEAD_CAP,
  });
  // Hitting the cap means leads are being dropped off the end of the board
  // with nothing on screen to say so. Loud in the logs is the minimum; the
  // real answer at that point is per-column pagination.
  if (rows.length === BOARD_LEAD_CAP) {
    logger.warn(
      { cap: BOARD_LEAD_CAP, filters: f },
      "leads board hit its row cap — leads past it are not being shown",
    );
  }
  const dtos = rows.map(toEnquiryDTO);

  const rnrIds = rows.filter((r) => r.stage === "rnr").map((r) => r.id);
  const progressById = await getRnrProgressBatch(rnrIds);
  for (const dto of dtos) {
    if (progressById.has(dto.id)) dto.rnrProgress = progressById.get(dto.id)!;
  }

  const pendingIds = await getLostRequestPendingBatch(rows.map((r) => r.id));
  for (const dto of dtos) {
    if (pendingIds.has(dto.id)) dto.lostRequestPending = true;
  }

  const assignedSubs = rows.flatMap((r) => (r.assignedToSub ? [r.assignedToSub] : []));
  const namesBySub = await getStaffNamesBatch(assignedSubs);
  for (const dto of dtos) {
    if (dto.assignedToSub && namesBySub.has(dto.assignedToSub)) {
      dto.assignedToName = namesBySub.get(dto.assignedToSub)!;
    }
  }

  if (f.rnrDone) return dtos.filter((d) => matchesRnrFilter(d.rnrProgress, f.rnrDone!));

  return dtos;
}

/**
 * Every tag currently in play across ALL active (non-deleted) leads — not
 * just whichever page/stage/tag-filtered subset happens to be loaded on the
 * board right now. The board's tag filter used to be seeded purely from the
 * client's already-fetched enquiries, so a real tag (e.g. "revisit") with no
 * carrier in the currently-loaded set — filtered out, past the board's
 * BOARD_LEAD_CAP, or just not on screen yet — silently couldn't be filtered
 * by at all. System tags (revisit/source/age/campaign) are computed on read
 * (see mergeLeadTags) and aren't always persisted to the DB tags column
 * (only synced on write), so this recomputes them the same way the board
 * itself does rather than scanning the raw column.
 */
export async function listDistinctActiveLeadTags(): Promise<string[]> {
  const rows = await prisma.enquiry.findMany({
    where: { deletedAt: null },
    select: {
      tags: true,
      source: true,
      campaignLabel: true,
      isReturningFlag: true,
      guest: { select: { dateOfBirth: true, isReturning: true, phone: true } },
    },
  });
  const all = new Set<string>();
  for (const r of rows) {
    for (const t of mergeLeadTags(r.tags, r.guest, r)) all.add(t);
  }
  return sortTags([...all]);
}

/**
 * Buckets by COMPLETION, not by a raw count, because the total isn't always
 * 3: a lead that re-enters RNR gets a second cadence, and production already
 * has leads sitting at 6 follow-ups. An exact "done === 3" test would report
 * one of those, half-worked, as complete.
 *
 *   none    — nothing attempted yet
 *   partial — started, not finished
 *   all     — every scheduled follow-up done
 *   open    — anything still outstanding (none + partial), the bucket a rep
 *             chasing calls actually wants
 *
 * A lead in RNR with no cadence tasks at all has null progress and matches
 * nothing: it was never scheduled, and folding it into "none done" would
 * report it alongside leads that were scheduled and then ignored.
 */
export function matchesRnrFilter(
  progress: { done: number; total: number } | null,
  filter: string,
): boolean {
  if (!progress || progress.total === 0) return false;
  const { done, total } = progress;
  switch (filter) {
    case "none":
      return done === 0;
    case "partial":
      return done > 0 && done < total;
    case "all":
      return done >= total;
    case "open":
      return done < total;
    default:
      return false;
  }
}

/**
 * assignedToName is snapshotted onto the Enquiry row at assignment time (see
 * the stage and owner-picker routes) rather than joined live — renaming a
 * user afterward left every lead they were already assigned to showing the
 * old name forever. These resolve the CURRENT StaffProfile.displayName for
 * display, falling back to the stored snapshot only if the profile row is
 * missing (e.g. legacy data with no matching StaffProfile), so a lookup miss
 * degrades to "possibly stale" rather than blank.
 */

/** Batch version for list responses — one query, not N+1. */
export async function getStaffNamesBatch(subs: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(subs));
  if (!unique.length) return new Map();
  const rows = await prisma.staffProfile.findMany({
    where: { keycloakId: { in: unique } },
    select: { keycloakId: true, displayName: true },
  });
  return new Map(rows.map((r) => [r.keycloakId, r.displayName]));
}

/** Attaches the assignee's current display name to a single already-built DTO. */
export async function withCurrentAssigneeName<
  T extends { assignedToSub: string | null; assignedToName: string | null },
>(dto: T): Promise<T> {
  if (!dto.assignedToSub) return dto;
  const profile = await prisma.staffProfile.findUnique({
    where: { keycloakId: dto.assignedToSub },
    select: { displayName: true },
  });
  return profile ? { ...dto, assignedToName: profile.displayName } : dto;
}

/**
 * The guest re-engaged (inbound WhatsApp/email/call) on a lead that was
 * soft-deleted — revives it instead of leaving it silently hidden or
 * spinning up a duplicate. Moves it back to "contacted" regardless of what
 * stage it was in when deleted, since re-engagement restarts the pipeline
 * conversation. Assignment is left untouched. No-ops if the enquiry isn't
 * actually soft-deleted.
 */
export async function reviveEnquiryIfDeleted(enquiryId: string): Promise<void> {
  const enquiry = await prisma.enquiry.findUnique({
    where: { id: enquiryId },
    select: { deletedAt: true, guestId: true },
  });
  if (!enquiry?.deletedAt) return;

  await prisma.enquiry.update({
    where: { id: enquiryId },
    data: { deletedAt: null, stage: "contacted", lastActivityAt: new Date() },
  });
  await prisma.activity.create({
    data: {
      enquiryId,
      guestId: enquiry.guestId,
      actorSub: "system",
      actorRole: "system",
      actorName: "Auto-revive",
      actionType: "lead_revived",
      metadata: { reason: "inbound activity after soft delete" },
    },
  });
}

export interface BulkImportRow {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  city?: string;
  gender?: string;
}

export interface BulkImportConflict {
  row: number;
  type: "duplicate_in_file" | "name_mismatch" | "soft_deleted";
  detail: string;
}

export interface BulkImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; error: string }[];
  /** Not failures — the row was still imported — but worth a human glance:
   *  two rows in this file resolved to the same guest, or an existing
   *  guest's name on file doesn't match what this file has for them. */
  conflicts: BulkImportConflict[];
  /** The slugified batch tag actually applied (empty if none was given). */
  tag: string;
}

const EMAIL_SCHEMA = z.string().email();

/**
 * Bulk CSV guest import — creates/updates Guest rows only, no per-row
 * Enquiry ticket (a data import isn't a new lead). Reuses the same dedup-
 * by-phone/email lookup as createEnquiry()'s returning-guest recognition,
 * and the same "only backfill missing fields, never overwrite" rule.
 *
 * `tag`, if given, is slugified and applied to every guest the import
 * actually touches (created or updated — not skipped/errored rows), so the
 * whole batch can be found again via the Guests tag filter afterward.
 */
export async function bulkImportGuests(rows: BulkImportRow[], tag?: string): Promise<BulkImportResult> {
  const result: BulkImportResult = { created: 0, updated: 0, skipped: 0, errors: [], conflicts: [], tag: "" };
  const batchTag = tag?.trim() ? slugifyTag(tag) : "";
  result.tag = batchTag;

  // Row number (first occurrence) seen so far for each normalized phone/email
  // in THIS file — lets us flag "row 12 is the same person as row 4" even
  // though the DB-level dedup silently treats it as a normal update.
  const seenInFile = new Map<string, number>();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 2; // +1 for 0-index, +1 for the header row
    const firstName = r.firstName?.trim();
    const lastName = r.lastName?.trim();
    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    const phone = r.phone?.trim() || undefined;
    const email = r.email?.trim() || undefined;
    const city = r.city?.trim() || undefined;
    const gender = r.gender?.trim() || undefined;

    if (!firstName) {
      result.errors.push({ row: rowNum, error: "Missing firstName" });
      result.skipped++;
      continue;
    }
    if (phone && !PHONE_RE.test(phone)) {
      result.errors.push({ row: rowNum, error: `Invalid phone "${phone}" — must be E.164, e.g. +919812345678` });
      result.skipped++;
      continue;
    }
    if (email && !EMAIL_SCHEMA.safeParse(email).success) {
      result.errors.push({ row: rowNum, error: `Invalid email "${email}"` });
      result.skipped++;
      continue;
    }
    if (!phone && !email) {
      result.errors.push({ row: rowNum, error: "Needs at least a phone or email" });
      result.skipped++;
      continue;
    }

    const fileKey = (phone ?? "") + "|" + (email?.toLowerCase() ?? "");
    const firstRow = seenInFile.get(fileKey);
    if (firstRow !== undefined) {
      result.conflicts.push({
        row: rowNum,
        type: "duplicate_in_file",
        detail: `Same phone/email as row ${firstRow} in this file`,
      });
    } else {
      seenInFile.set(fileKey, rowNum);
    }

    try {
      // A soft-deleted guest is skipped rather than revived. Everywhere else
      // the guest themselves made contact, which is a good reason to bring
      // their record back; a CSV someone uploaded is not, and silently
      // resurrecting a deleted guest from a marketing list is the wrong
      // default. Reported as a conflict so it's visible, not swallowed —
      // without this the row would still fail, just with an opaque
      // "Unique constraint failed on Guest_phone_key".
      const deleted = await findReturningGuest(phone, email, { includeDeleted: true });
      if (deleted?.deletedAt) {
        result.conflicts.push({
          row: rowNum,
          type: "soft_deleted",
          detail: `"${deleted.fullName}" was deleted on ${deleted.deletedAt.toISOString().slice(0, 10)} — skipped. Restore the guest first if you want them back.`,
        });
        result.skipped++;
        continue;
      }

      const existing = await findReturningGuest(phone, email);
      if (existing) {
        if (existing.fullName.trim().toLowerCase() !== fullName.toLowerCase()) {
          result.conflicts.push({
            row: rowNum,
            type: "name_mismatch",
            detail: `File says "${fullName}", existing record says "${existing.fullName}"`,
          });
        }
        await prisma.guest.update({
          where: { id: existing.id },
          data: {
            email: existing.email ?? email,
            city: existing.city ?? city,
            gender: existing.gender ?? gender,
            tags: batchTag
              ? Array.from(new Set([...existing.tags, batchTag]))
              : existing.tags,
          },
        });
        result.updated++;
      } else {
        await prisma.guest.create({
          data: { fullName, phone, email, city, gender, tags: batchTag ? [batchTag] : [] },
        });
        result.created++;
      }
    } catch (err) {
      result.errors.push({ row: rowNum, error: err instanceof Error ? err.message : "Unknown error" });
      result.skipped++;
    }
  }

  return result;
}

/**
 * Returning-guest recognition (spec §6.1, goal #2).
 * Look up by phone OR email before creating a new guest.
 *
 * `includeDeleted` also matches SOFT-DELETED guests. Callers that go on to
 * create a guest must pass it: Guest.phone/email are @unique across the whole
 * table (a plain index, not one partial on deletedAt), so a hidden row still
 * owns that phone number and a create would die on a P2002. Those callers are
 * expected to revive the match — see reviveGuestIfDeleted(). Left off by
 * default so a caller that only wants live guests can't resurrect one by
 * accident.
 */
export async function findReturningGuest(
  phone?: string | null,
  email?: string | null,
  opts: { includeDeleted?: boolean } = {},
) {
  const or: Prisma.GuestWhereInput[] = [];
  if (phone) or.push({ phone });
  if (email) or.push({ email });
  if (or.length === 0) return null;
  return prisma.guest.findFirst({
    where: { ...(opts.includeDeleted ? {} : { deletedAt: null }), OR: or },
    include: {
      enquiries: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { enquiries: true } },
    },
  });
}
