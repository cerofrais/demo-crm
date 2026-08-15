/**
 * Admin-only archive of soft-deleted leads.
 *
 * A "deleted" lead (Enquiry.deletedAt) is hidden from the pipeline but keeps
 * every child record — notes, tasks, messages, calls with their recordings and
 * transcripts, documents, and the activity trail — because the delete is a
 * soft one by design (see the deletedAt comment in prisma/schema.prisma and
 * lead-deletion.ts's auto-sweep). Until now nothing surfaced any of it, so a
 * lead swept by the auto-delete job was effectively unreachable even though
 * all its history was still sitting in the database.
 *
 * This reads that history back. Everything here is read-only: no route in this
 * feature writes, restores, or purges — recovering a lead is deliberately not
 * part of it.
 *
 * Note the distinction from a HARD delete (guest-delete.ts), which wipes the
 * rows outright and leaves nothing for this to find.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { deleteObject } from "./storage";
import { formatActionLabel } from "./activity-log";
import { mergeLeadTags, sortTags } from "./lead-tags";

export interface DeletedLeadListItemDTO {
  id: string;
  guestId: string;
  guestName: string;
  guestPhone: string | null;
  guestEmail: string | null;
  /** The stage the lead was sitting in when it was deleted. */
  stage: string;
  source: string;
  campaignLabel: string | null;
  assignedToName: string | null;
  deletedAt: string;
  createdAt: string;
  /** Never cleared by the soft delete — system tags (age/source/revisit/
   *  package/campaign) and any custom tags the lead had are kept exactly as
   *  they were, so the archive can be filtered by them like the live board. */
  tags: string[];
  /** How much history is retained — lets the list show what's worth opening. */
  counts: {
    activities: number;
    messages: number;
    calls: number;
    recordings: number;
    notes: number;
    tasks: number;
    documents: number;
  };
}

export interface DeletedLeadDetailDTO extends DeletedLeadListItemDTO {
  lostReason: string | null;
  quotedPriceINR: number | null;
  proposedDates: string | null;
  intakeNotes: string | null;
  aiScore: number | null;
  aiScoreReason: string | null;
  activities: {
    id: string;
    createdAt: string;
    actorName: string | null;
    actorRole: string;
    actionType: string;
    actionLabel: string;
    metadata: unknown;
  }[];
  messages: {
    id: string;
    channel: string;
    direction: string;
    subject: string | null;
    body: string;
    fromEmail: string | null;
    toEmail: string | null;
    status: string;
    createdAt: string;
    attachment: { id: string; filename: string; mimeType: string } | null;
  }[];
  calls: {
    id: string;
    direction: string;
    status: string;
    customerPhone: string;
    repName: string | null;
    startedAt: string;
    durationSec: number;
    /** The recording is streamed through /api/calls/:id/recording, same as the
     *  live Calls page — the raw provider URL is never handed to the client. */
    hasRecording: boolean;
    transcript: string | null;
    transcriptEnglish: string | null;
    aiSummary: string | null;
    aiScore: number | null;
  }[];
  notes: { id: string; body: string; authorName: string | null; createdAt: string }[];
  tasks: { id: string; title: string; status: string; dueAt: string | null; createdAt: string }[];
  documents: { id: string; filename: string; mimeType: string; category: string; createdAt: string }[];
}

export interface DeletedLeadFilters {
  /** Matches guest name, phone or email — the three things an admin looking
   *  for a specific deleted lead actually has to hand. */
  q?: string;
  from?: string;
  to?: string;
  /** LeadSource — where the lead originally came from. */
  source?: string;
  /** AND semantics (a lead must carry every tag listed), matching the live
   *  board's own multi-select tag filter (leads-workspace.tsx). */
  tags?: string[];
}

function buildWhere(filters: DeletedLeadFilters) {
  const q = filters.q?.trim();
  return {
    ...(filters.source ? { source: filters.source as Prisma.EnquiryWhereInput["source"] } : {}),
    ...(filters.tags?.length ? { tags: { hasEvery: filters.tags } } : {}),
    deletedAt: {
      not: null,
      ...(filters.from ? { gte: new Date(filters.from) } : {}),
      ...(filters.to ? { lte: new Date(filters.to) } : {}),
    },
    ...(q
      ? {
          guest: {
            OR: [
              { fullName: { contains: q, mode: "insensitive" as const } },
              { phone: { contains: q } },
              { email: { contains: q, mode: "insensitive" as const } },
            ],
          },
        }
      : {}),
  };
}

/**
 * Every distinct tag currently sitting on a soft-deleted lead — the universe
 * the archive's tag filter offers. Recomputed live via mergeLeadTags rather
 * than scanning the persisted Enquiry.tags column directly: system tags
 * (age:/source:/campaign:/revisit) only get written back to that column on
 * a write (see syncEnquiryTags) — a lead deleted before anyone ever touched
 * it (e.g. the auto-delete sweep on an untouched Lost/Dead card) can have a
 * genuinely stale tags column, silently missing a tag like "revisit" even
 * though the guest really was returning. This also omits the shared
 * /api/tags vocabulary on purpose — that list carries tags never applied to
 * any deleted lead, which would show as a filter chip matching nothing.
 */
export async function listDistinctDeletedLeadTags(): Promise<string[]> {
  const rows = await prisma.enquiry.findMany({
    where: { deletedAt: { not: null } },
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
 * Cursor-paginated list of soft-deleted leads, newest deletion first. The
 * cursor is the previous page's last `deletedAt`, matching the convention used
 * by listActivity()/listAiDecisions().
 */
export async function listDeletedLeads(
  filters: DeletedLeadFilters,
  limit = 25,
  cursor?: string,
): Promise<{
  items: DeletedLeadListItemDTO[];
  nextCursor: string | null;
  /** Rows matching the current filters — the page is only `limit` of these. */
  matching: number;
  /** Every soft-deleted lead, ignoring filters, so the UI can say "of N". */
  total: number;
}> {
  const where = buildWhere(filters);
  // Two counts, not one: "12 of 187" is the useful line, and without the
  // unfiltered total a filtered view gives no sense of how much was excluded.
  const [matching, total] = await Promise.all([
    prisma.enquiry.count({ where }),
    prisma.enquiry.count({ where: { deletedAt: { not: null } } }),
  ]);
  const rows = await prisma.enquiry.findMany({
    where: {
      ...where,
      ...(cursor ? { deletedAt: { ...where.deletedAt, lt: new Date(cursor) } } : {}),
    },
    orderBy: { deletedAt: "desc" },
    take: limit + 1,
    include: {
      guest: { select: { fullName: true, phone: true, email: true, dateOfBirth: true, isReturning: true } },
      _count: {
        select: { activities: true, messages: true, calls: true, notes: true, tasks: true, documents: true },
      },
    },
  });

  const page = rows.slice(0, limit);

  // _count can't express "calls that have a recording", so it's counted
  // separately — one grouped query for the page rather than one per lead.
  const recordingCounts = new Map<string, number>();
  if (page.length) {
    const grouped = await prisma.call.groupBy({
      by: ["enquiryId"],
      where: { enquiryId: { in: page.map((e) => e.id) }, recordingUrl: { not: null } },
      _count: { _all: true },
    });
    for (const g of grouped) {
      if (g.enquiryId) recordingCounts.set(g.enquiryId, g._count._all);
    }
  }

  return {
    items: page.map((e) => ({
      id: e.id,
      guestId: e.guestId,
      guestName: e.guest.fullName,
      guestPhone: e.guest.phone,
      guestEmail: e.guest.email,
      stage: e.stage,
      source: e.source,
      campaignLabel: e.campaignLabel,
      assignedToName: e.assignedToName,
      deletedAt: e.deletedAt!.toISOString(),
      createdAt: e.createdAt.toISOString(),
      // Recomputed live, not the raw persisted column — see the comment on
      // listDistinctDeletedLeadTags for why: system tags (e.g. "revisit")
      // only get written back on a write that never came if the lead was
      // deleted (e.g. the auto-delete sweep) before anyone touched it.
      tags: mergeLeadTags(e.tags, e.guest, e),
      counts: {
        activities: e._count.activities,
        messages: e._count.messages,
        calls: e._count.calls,
        recordings: recordingCounts.get(e.id) ?? 0,
        notes: e._count.notes,
        tasks: e._count.tasks,
        documents: e._count.documents,
      },
    })),
    nextCursor: rows.length > limit ? page[page.length - 1].deletedAt!.toISOString() : null,
    matching,
    total,
  };
}

/**
 * Permanently destroys one already-soft-deleted lead and everything scoped to
 * it. Irreversible — there is no backup and nothing to restore from.
 *
 * Only operates on a lead that is ALREADY soft-deleted: purging is a second,
 * deliberate step from the Deleted Leads archive, never a shortcut that skips
 * the reversible delete.
 *
 * Everything is scoped by `enquiryId`, never `guestId` — the guest may have
 * other leads, and this must not touch them or the Guest row itself. Note the
 * consequence for shared threads: WhatsApp/email conversations are stored per
 * guest with an optional enquiry link, so messages tagged to THIS lead are
 * destroyed while the rest of that guest's thread survives. That is the right
 * behaviour for an erasure request, but it does leave a gap in the guest's
 * conversation if they have another live lead.
 *
 * Delete order mirrors guest-delete.ts and respects the FK graph:
 * AiDecision before Call (it references callId), Message before Document (it
 * references attachmentDocumentId), Enquiry last — Note, Task and any
 * remaining Message cascade with it. Note.attachmentDocumentId is SetNull, so
 * clearing Documents first can't trip it.
 */
export async function hardDeleteLead(
  enquiryId: string,
  actor: { sub: string; name?: string | null },
): Promise<{ guestName: string; purged: DeletedLeadListItemDTO["counts"] } | null> {
  const lead = await prisma.enquiry.findFirst({
    where: { id: enquiryId, deletedAt: { not: null } },
    include: {
      guest: { select: { id: true, fullName: true } },
      _count: {
        select: { activities: true, messages: true, calls: true, notes: true, tasks: true, documents: true },
      },
    },
  });
  // Null for a lead that doesn't exist OR isn't soft-deleted — a live lead can
  // never be purged in one step from here.
  if (!lead) return null;

  const docs = await prisma.document.findMany({
    where: { enquiryId },
    select: { storageKey: true },
  });
  const recordings = await prisma.call.count({ where: { enquiryId, recordingUrl: { not: null } } });

  const purged = {
    activities: lead._count.activities,
    messages: lead._count.messages,
    calls: lead._count.calls,
    recordings,
    notes: lead._count.notes,
    tasks: lead._count.tasks,
    documents: lead._count.documents,
  };

  await prisma.$transaction([
    prisma.aiDecision.deleteMany({ where: { enquiryId } }),
    prisma.message.deleteMany({ where: { enquiryId } }),
    prisma.call.deleteMany({ where: { enquiryId } }),
    prisma.document.deleteMany({ where: { enquiryId } }),
    prisma.activity.deleteMany({ where: { enquiryId } }),
    prisma.enquiry.delete({ where: { id: enquiryId } }),
    // Written in the same transaction, deliberately keyed to the GUEST with no
    // enquiryId, so it survives the activity wipe just above. Without it a
    // purge would leave no trace at all — which is exactly why there's no way
    // to reconstruct how many leads were hard-deleted historically.
    prisma.activity.create({
      data: {
        guestId: lead.guest.id,
        actorSub: actor.sub,
        actorRole: "ADMIN",
        actorName: actor.name ?? "Admin",
        actionType: "lead_purged",
        metadata: {
          purgedEnquiryId: enquiryId,
          stage: lead.stage,
          source: lead.source,
          campaignLabel: lead.campaignLabel,
          softDeletedAt: lead.deletedAt?.toISOString() ?? null,
          purged,
        },
      },
    }),
  ]);

  // Storage objects last: a failure here leaks a file but must not roll back
  // the erasure, and the rows referencing them are already gone.
  await Promise.all(
    docs.map((d) =>
      deleteObject(d.storageKey).catch((err) =>
        logger.error({ err, storageKey: d.storageKey }, "lead purge: failed to remove storage object"),
      ),
    ),
  );

  logger.warn(
    { enquiryId, guestId: lead.guest.id, guestName: lead.guest.fullName, purgedBySub: actor.sub, purged },
    "lead hard-deleted — all history permanently wiped",
  );
  return { guestName: lead.guest.fullName, purged };
}

/**
 * Everything retained for one soft-deleted lead. Returns null for a lead that
 * doesn't exist *or* isn't deleted — a live lead has to be read through the
 * normal pipeline routes, so this can't be used to sidestep the stage/ownership
 * scoping those apply.
 */
export async function getDeletedLead(id: string): Promise<DeletedLeadDetailDTO | null> {
  const e = await prisma.enquiry.findFirst({
    where: { id, deletedAt: { not: null } },
    include: {
      guest: { select: { fullName: true, phone: true, email: true, dateOfBirth: true, isReturning: true } },
      activities: { orderBy: { createdAt: "desc" } },
      messages: {
        orderBy: { createdAt: "desc" },
        include: { attachmentDocument: { select: { id: true, filename: true, mimeType: true } } },
      },
      calls: { orderBy: { startedAt: "desc" } },
      notes: { orderBy: { createdAt: "desc" } },
      tasks: { orderBy: { createdAt: "desc" } },
      documents: { orderBy: { createdAt: "desc" } },
      _count: {
        select: { activities: true, messages: true, calls: true, notes: true, tasks: true, documents: true },
      },
    },
  });
  if (!e) return null;

  return {
    id: e.id,
    guestId: e.guestId,
    guestName: e.guest.fullName,
    guestPhone: e.guest.phone,
    guestEmail: e.guest.email,
    stage: e.stage,
    source: e.source,
    campaignLabel: e.campaignLabel,
    assignedToName: e.assignedToName,
    deletedAt: e.deletedAt!.toISOString(),
    createdAt: e.createdAt.toISOString(),
    counts: {
      activities: e._count.activities,
      messages: e._count.messages,
      calls: e._count.calls,
      recordings: e.calls.filter((c) => c.recordingUrl).length,
      notes: e._count.notes,
      tasks: e._count.tasks,
      documents: e._count.documents,
    },
    lostReason: e.lostReason,
    quotedPriceINR: e.quotedPriceINR,
    proposedDates: e.proposedDates,
    intakeNotes: e.intakeNotes,
    tags: mergeLeadTags(e.tags, e.guest, e),
    aiScore: e.aiScore,
    aiScoreReason: e.aiScoreReason,
    activities: e.activities.map((a) => ({
      id: a.id,
      createdAt: a.createdAt.toISOString(),
      actorName: a.actorName,
      actorRole: a.actorRole,
      actionType: a.actionType,
      actionLabel: formatActionLabel(a.actionType),
      metadata: a.metadata,
    })),
    messages: e.messages.map((m) => ({
      id: m.id,
      channel: m.channel,
      direction: m.direction,
      subject: m.subject,
      body: m.body,
      fromEmail: m.fromEmail,
      toEmail: m.toEmail,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
      attachment: m.attachmentDocument,
    })),
    calls: e.calls.map((c) => ({
      id: c.id,
      direction: c.direction,
      status: c.status,
      customerPhone: c.customerPhone,
      repName: c.repName,
      startedAt: c.startedAt.toISOString(),
      durationSec: c.durationSec,
      hasRecording: Boolean(c.recordingUrl),
      transcript: c.transcript,
      transcriptEnglish: c.transcriptEnglish,
      aiSummary: c.aiSummary,
      aiScore: c.aiScore,
    })),
    notes: e.notes.map((n) => ({
      id: n.id,
      body: n.body,
      authorName: n.authorName,
      createdAt: n.createdAt.toISOString(),
    })),
    tasks: e.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      dueAt: t.dueAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    })),
    documents: e.documents.map((d) => ({
      id: d.id,
      filename: d.filename,
      mimeType: d.mimeType,
      category: d.category,
      createdAt: d.createdAt.toISOString(),
    })),
  };
}
