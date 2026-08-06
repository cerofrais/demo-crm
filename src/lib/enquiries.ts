import { z } from "zod";
import type { Enquiry, Guest, Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { ageFromDob, ageGroup } from "./utils";
import { mergeLeadTags, slugifyTag } from "./lead-tags";
import { getRnrProgressBatch, getLostRequestPendingBatch, hasOpenDeletionApprovalTask } from "./tasks";
import { PHONE_RE } from "./validation";
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

export async function listEnquiries(f: EnquiryFilters): Promise<EnquiryDTO[]> {
  const rows = await prisma.enquiry.findMany({
    where: buildWhere(f),
    include: { guest: true },
    orderBy: [{ stage: "asc" }, { boardPosition: "asc" }, { lastActivityAt: "desc" }],
    take: 500,
  });
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

  return dtos;
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
  type: "duplicate_in_file" | "name_mismatch";
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
 */
export async function findReturningGuest(
  phone?: string | null,
  email?: string | null,
) {
  const or: Prisma.GuestWhereInput[] = [];
  if (phone) or.push({ phone });
  if (email) or.push({ email });
  if (or.length === 0) return null;
  return prisma.guest.findFirst({
    where: { deletedAt: null, OR: or },
    include: {
      enquiries: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { enquiries: true } },
    },
  });
}
