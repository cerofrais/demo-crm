/**
 * Folding one lead into another, keeping everything.
 *
 * Two cards for the same person is routine here: an enquiry arrives by email,
 * a rep picks up the phone and makes a lead from the call, and now the
 * conversation is in two places. Until now the CRM had no answer to that. The
 * only way to tidy it was to delete one card — and deleting a lead wipes its
 * messages, calls and activity, which is exactly what happened to a guest
 * whose WhatsApp history and a call went with the card an admin removed.
 *
 * So this moves rather than deletes. Every message, call, note, task, document
 * and audit row on the losing lead is re-pointed at the surviving one; its
 * phone number and email move across if the survivor has none; the losing card
 * is soft-deleted, never purged. Each moved id is written to a LeadMerge row,
 * so the whole thing can be put back (see undoLeadMerge).
 *
 * What it deliberately does NOT do: decide which card survives. The rep picks,
 * because the right survivor is a judgement about which card the business is
 * working, not something a rule can infer.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "./prisma";
import { ApiError } from "./api";
import { syncEnquiryTags } from "./tags-service";
import { logger } from "./logger";

export interface MergePreview {
  messages: number;
  calls: number;
  notes: number;
  tasks: number;
  documents: number;
  /** Guest fields the survivor would gain, e.g. a phone it does not have. */
  guestFields: string[];
  /** True when the two leads are already on one guest row. */
  sameGuest: boolean;
}

export interface MergeResult extends MergePreview {
  mergeId: string;
}

/** Guest columns worth carrying across when the survivor has none. */
export const GUEST_FIELDS = ["phone", "email", "city", "gender", "dateOfBirth", "businessName", "businessRole"] as const;
type GuestField = (typeof GUEST_FIELDS)[number];

/**
 * Which rows belong to the losing card.
 *
 * On ONE guest, WhatsApp and email are already shared between the two cards —
 * they are keyed to the person — so sweeping by guest would drag the surviving
 * card's own messages through the move and, worse, hand them back to the loser
 * on an undo. Only across two guests does guest-level history need to move.
 */
export function mergeScope(sameGuest: boolean, sourceEnquiryId: string, sourceGuestId: string) {
  return sameGuest
    ? { enquiryId: sourceEnquiryId }
    : { OR: [{ enquiryId: sourceEnquiryId }, { guestId: sourceGuestId }] };
}

/**
 * The identity fields the survivor would gain: ones it is missing and the
 * other card has. Never overwrites — the card being kept is the one the
 * business trusts, and a merge is not the place to argue with it.
 */
export function guestFieldsToMove(
  source: Partial<Record<GuestField, unknown>>,
  target: Partial<Record<GuestField, unknown>>,
): GuestField[] {
  return GUEST_FIELDS.filter((f) => !target[f] && Boolean(source[f]));
}

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

async function loadPair(tx: Tx, sourceId: string, targetId: string) {
  const [source, target] = await Promise.all([
    tx.enquiry.findUnique({ where: { id: sourceId }, include: { guest: true } }),
    tx.enquiry.findUnique({ where: { id: targetId }, include: { guest: true } }),
  ]);
  if (!source) throw new ApiError("NOT_FOUND", "The lead being merged no longer exists.", 404);
  if (!target) throw new ApiError("NOT_FOUND", "The lead being merged into no longer exists.", 404);
  if (source.id === target.id) throw new ApiError("VALIDATION_ERROR", "Pick two different leads.", 400);
  if (target.deletedAt) throw new ApiError("VALIDATION_ERROR", "The surviving lead has been deleted.", 400);
  return { source, target };
}

/** What a merge would move, without moving anything. */
export async function previewLeadMerge(sourceId: string, targetId: string): Promise<MergePreview> {
  const { source, target } = await loadPair(prisma, sourceId, targetId);
  const sameGuest = source.guestId === target.guestId;

  // Guest-level history (WhatsApp, email, calls) only moves when the two cards
  // sit on different guest rows; on one guest it is already shared.
  const guestScope = mergeScope(sameGuest, source.id, source.guestId);

  const [messages, calls, notes, tasks, documents] = await Promise.all([
    prisma.message.count({ where: guestScope }),
    prisma.call.count({ where: guestScope }),
    prisma.note.count({ where: { enquiryId: source.id } }),
    prisma.task.count({ where: { enquiryId: source.id } }),
    prisma.document.count({ where: guestScope }),
  ]);

  const guestFields = sameGuest ? [] : guestFieldsToMove(source.guest, target.guest).map(String);

  return { messages, calls, notes, tasks, documents, guestFields, sameGuest };
}

export async function mergeLeads(input: {
  sourceEnquiryId: string;
  targetEnquiryId: string;
  actor: { sub: string; role: string; name: string };
}): Promise<MergeResult> {
  const result = await prisma.$transaction(async (tx) => {
    const { source, target } = await loadPair(tx, input.sourceEnquiryId, input.targetEnquiryId);
    const sameGuest = source.guestId === target.guestId;

    const scope = mergeScope(sameGuest, source.id, source.guestId) as Prisma.MessageWhereInput;

    // Ids first, then the update: an undo needs to know exactly which rows
    // moved, and "everything pointing at the target now" would also sweep up
    // whatever was already there.
    const [msgIds, callIds, noteIds, taskIds, docIds, actIds, aiIds] = await Promise.all([
      tx.message.findMany({ where: scope, select: { id: true } }),
      tx.call.findMany({ where: scope as Prisma.CallWhereInput, select: { id: true } }),
      tx.note.findMany({ where: { enquiryId: source.id }, select: { id: true } }),
      tx.task.findMany({ where: { enquiryId: source.id }, select: { id: true } }),
      tx.document.findMany({ where: scope as Prisma.DocumentWhereInput, select: { id: true } }),
      tx.activity.findMany({ where: scope as Prisma.ActivityWhereInput, select: { id: true } }),
      tx.aiDecision.findMany({ where: scope as Prisma.AiDecisionWhereInput, select: { id: true } }),
    ]);
    const membershipIds = sameGuest
      ? []
      : (await tx.membership.findMany({ where: { guestId: source.guestId }, select: { id: true } })).map((r) => r.id);
    const healthIds = sameGuest
      ? []
      : (await tx.healthProfile.findMany({ where: { guestId: source.guestId }, select: { id: true } })).map((r) => r.id);

    const to = { guestId: target.guestId, enquiryId: target.id };
    await tx.message.updateMany({ where: { id: { in: msgIds.map((r) => r.id) } }, data: to });
    await tx.call.updateMany({ where: { id: { in: callIds.map((r) => r.id) } }, data: to });
    await tx.note.updateMany({ where: { id: { in: noteIds.map((r) => r.id) } }, data: { enquiryId: target.id } });
    await tx.task.updateMany({ where: { id: { in: taskIds.map((r) => r.id) } }, data: { enquiryId: target.id } });
    await tx.document.updateMany({ where: { id: { in: docIds.map((r) => r.id) } }, data: to });
    await tx.activity.updateMany({ where: { id: { in: actIds.map((r) => r.id) } }, data: to });
    await tx.aiDecision.updateMany({ where: { id: { in: aiIds.map((r) => r.id) } }, data: to });
    if (membershipIds.length) {
      await tx.membership.updateMany({ where: { id: { in: membershipIds } }, data: { guestId: target.guestId } });
    }
    if (healthIds.length) {
      await tx.healthProfile.updateMany({ where: { id: { in: healthIds } }, data: { guestId: target.guestId } });
    }

    // Identity: a phone or email the survivor lacks moves across. Cleared from
    // the source first — both columns are unique, including on soft-deleted
    // rows, so the old holder has to let go before the new one can take it.
    const guestFieldsMoved: Record<string, unknown> = {};
    if (!sameGuest) {
      const take: Partial<Record<GuestField, unknown>> = {};
      for (const field of guestFieldsToMove(source.guest, target.guest)) {
        take[field] = source.guest[field];
        guestFieldsMoved[field] = source.guest[field];
      }
      if (Object.keys(take).length) {
        const clear: Partial<Record<GuestField, null>> = {};
        for (const field of Object.keys(take) as GuestField[]) {
          if (field === "phone" || field === "email") clear[field] = null;
        }
        if (Object.keys(clear).length) {
          await tx.guest.update({ where: { id: source.guestId }, data: clear as Prisma.GuestUpdateInput });
        }
        await tx.guest.update({ where: { id: target.guestId }, data: take as Prisma.GuestUpdateInput });
      }
      // The guest tags (WhatsApp lines, blocked, …) are the person's, not the
      // card's, so the survivor keeps the union.
      const tags = [...new Set([...target.guest.tags, ...source.guest.tags])];
      if (tags.length !== target.guest.tags.length) {
        await tx.guest.update({ where: { id: target.guestId }, data: { tags } });
      }
    }

    // The surviving card takes the union of both cards' tags, and the earlier
    // of the two creation dates: the enquiry began when the first one did.
    await tx.enquiry.update({
      where: { id: target.id },
      data: {
        tags: [...new Set([...target.tags, ...source.tags])],
        lastActivityAt: new Date(),
        ...(target.preferredCheckIn ? {} : { preferredCheckIn: source.preferredCheckIn }),
        ...(target.campaignLabel ? {} : { campaignLabel: source.campaignLabel }),
        ...(target.intakeNotes || !source.intakeNotes ? {} : { intakeNotes: source.intakeNotes }),
      },
    });

    // The losing card is soft-deleted, never purged — undo depends on it still
    // being there, and so does anyone asking what happened.
    await tx.enquiry.update({ where: { id: source.id }, data: { deletedAt: new Date() } });
    if (!sameGuest) {
      const left = await tx.enquiry.count({ where: { guestId: source.guestId, deletedAt: null } });
      if (left === 0) await tx.guest.update({ where: { id: source.guestId }, data: { deletedAt: new Date() } });
    }

    const merge = await tx.leadMerge.create({
      data: {
        targetEnquiryId: target.id,
        sourceEnquiryId: source.id,
        targetGuestId: target.guestId,
        sourceGuestId: source.guestId,
        movedMessageIds: msgIds.map((r) => r.id),
        movedCallIds: callIds.map((r) => r.id),
        movedNoteIds: noteIds.map((r) => r.id),
        movedTaskIds: taskIds.map((r) => r.id),
        movedDocumentIds: docIds.map((r) => r.id),
        movedActivityIds: actIds.map((r) => r.id),
        movedAiDecisionIds: aiIds.map((r) => r.id),
        movedMembershipIds: membershipIds,
        movedHealthProfileIds: healthIds,
        guestFieldsMoved: guestFieldsMoved as Prisma.InputJsonValue,
        mergedBySub: input.actor.sub,
        mergedByName: input.actor.name,
      },
    });

    await tx.activity.create({
      data: {
        enquiryId: target.id,
        guestId: target.guestId,
        actorSub: input.actor.sub,
        actorRole: input.actor.role,
        actorName: input.actor.name,
        actionType: "leads_merged",
        metadata: {
          mergeId: merge.id,
          fromEnquiryId: source.id,
          fromGuestName: source.guest.fullName,
          messages: msgIds.length,
          calls: callIds.length,
          notes: noteIds.length,
          tasks: taskIds.length,
          documents: docIds.length,
        },
      },
    });

    return {
      mergeId: merge.id,
      messages: msgIds.length,
      calls: callIds.length,
      notes: noteIds.length,
      tasks: taskIds.length,
      documents: docIds.length,
      guestFields: Object.keys(guestFieldsMoved),
      sameGuest,
    };
  });

  // Outside the transaction: tag sync reads the row it just wrote.
  await syncEnquiryTags(input.targetEnquiryId).catch((err) =>
    logger.warn({ err, enquiryId: input.targetEnquiryId }, "lead merge: tag sync failed"),
  );

  logger.info({ ...result, by: input.actor.sub }, "leads merged");
  return result;
}

/** Put a merge back: every row returns to the lead it came from. */
export async function undoLeadMerge(mergeId: string, actor: { sub: string; role: string; name: string }): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const merge = await tx.leadMerge.findUnique({ where: { id: mergeId } });
    if (!merge) throw new ApiError("NOT_FOUND", "That merge is not on record.", 404);
    if (merge.undoneAt) throw new ApiError("VALIDATION_ERROR", "That merge has already been undone.", 400);

    const back = { guestId: merge.sourceGuestId, enquiryId: merge.sourceEnquiryId };
    await tx.message.updateMany({ where: { id: { in: merge.movedMessageIds } }, data: back });
    await tx.call.updateMany({ where: { id: { in: merge.movedCallIds } }, data: back });
    await tx.note.updateMany({ where: { id: { in: merge.movedNoteIds } }, data: { enquiryId: merge.sourceEnquiryId } });
    await tx.task.updateMany({ where: { id: { in: merge.movedTaskIds } }, data: { enquiryId: merge.sourceEnquiryId } });
    await tx.document.updateMany({ where: { id: { in: merge.movedDocumentIds } }, data: back });
    await tx.activity.updateMany({ where: { id: { in: merge.movedActivityIds } }, data: back });
    await tx.aiDecision.updateMany({ where: { id: { in: merge.movedAiDecisionIds } }, data: back });
    if (merge.movedMembershipIds.length) {
      await tx.membership.updateMany({ where: { id: { in: merge.movedMembershipIds } }, data: { guestId: merge.sourceGuestId } });
    }
    if (merge.movedHealthProfileIds.length) {
      await tx.healthProfile.updateMany({ where: { id: { in: merge.movedHealthProfileIds } }, data: { guestId: merge.sourceGuestId } });
    }

    // Identity goes back the way it came: off the survivor first, because the
    // columns are unique.
    const moved = (merge.guestFieldsMoved ?? {}) as Record<string, unknown>;
    const fields = Object.keys(moved) as GuestField[];
    if (fields.length) {
      const clear: Record<string, null> = {};
      for (const f of fields) if (f === "phone" || f === "email") clear[f] = null;
      if (Object.keys(clear).length) {
        await tx.guest.update({ where: { id: merge.targetGuestId }, data: clear as Prisma.GuestUpdateInput });
      }
      await tx.guest.update({ where: { id: merge.sourceGuestId }, data: moved as Prisma.GuestUpdateInput });
    }

    await tx.enquiry.update({ where: { id: merge.sourceEnquiryId }, data: { deletedAt: null } });
    await tx.guest.update({ where: { id: merge.sourceGuestId }, data: { deletedAt: null } });
    await tx.leadMerge.update({ where: { id: mergeId }, data: { undoneAt: new Date(), undoneBySub: actor.sub } });

    await tx.activity.create({
      data: {
        enquiryId: merge.targetEnquiryId,
        guestId: merge.targetGuestId,
        actorSub: actor.sub,
        actorRole: actor.role,
        actorName: actor.name,
        actionType: "lead_merge_undone",
        metadata: { mergeId, restoredEnquiryId: merge.sourceEnquiryId },
      },
    });
  });

  logger.info({ mergeId, by: actor.sub }, "lead merge undone");
}
