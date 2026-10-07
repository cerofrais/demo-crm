import { prisma } from "./prisma";
import { encryptJson } from "./crypto";
import { logger } from "./logger";
import { emptyHealthRecord, type HealthRecord } from "./health";

/**
 * System-actor (no session/RBAC) writes for auto-ingested health data — the
 * medical-screening-form email poller (see medical-form-parser.ts).
 *
 * ONE FORM = ONE RECORD. This used to merge every submission for a phone
 * number into a single record per guest, which was wrong in a way that only
 * showed up in the data: a family shares a phone, Guest.phone is unique, so
 * three siblings' forms all resolved to one guest and were blended into one
 * medical history. Records are now append-only and carry their own subject.
 *
 * Repeat submissions for the SAME subject (name + phone) are still written as
 * separate records and flagged `hasDuplicate` for a human to resolve, because
 * a second form may be a correction or a genuine second visit and nothing
 * here can tell which. Guessing is what caused the original bug.
 */

/** Same person, for the purpose of the duplicate flag: name + phone, both
 *  normalised. Name alone is far too loose in a family (three Siddis), and
 *  phone alone is exactly the assumption that caused the merge bug. */
export function subjectKey(name: string | null | undefined, phone: string | null | undefined): string {
  return `${(name ?? "").trim().toLowerCase().replace(/\s+/g, " ")}|${(phone ?? "").trim()}`;
}

export interface FormHealthRecordInput {
  /** The guest that owns the PHONE — not necessarily the record's subject. */
  guestId: string;
  /** Who the form is about. */
  subjectName: string | null;
  subjectPhone: string | null;
  record: Partial<HealthRecord>;
  /** RFC Message-ID of the form email; the idempotency key. */
  sourceMessageId: string | null;
}

/**
 * Store one screening-form submission as its own record.
 *
 * Never merges into an existing record — that is the whole point of this
 * function. Two things stop it duplicating anyway:
 *   • `sourceMessageId` is unique, so the same email can never land twice
 *     however often it is re-polled or replayed;
 *   • a genuine second form for the same subject IS written, and every
 *     record sharing that subject is flagged `hasDuplicate` so a human
 *     decides whether it is a correction or a second visit.
 *
 * Logs the same content-free "health_update" activity the doctor-facing
 * editor logs — the "never log health contents" rule applies here too.
 */
export async function createHealthRecordFromForm(input: FormHealthRecordInput): Promise<void> {
  const { guestId, subjectName, subjectPhone, sourceMessageId } = input;

  // Idempotency first: a re-polled email must not produce a second record.
  if (sourceMessageId) {
    const already = await prisma.healthProfile.findUnique({
      where: { sourceMessageId },
      select: { id: true },
    });
    if (already) {
      logger.info({ guestId, sourceMessageId }, "health-ingest: form already stored, skipping");
      return;
    }
  }

  // The submission stands alone: defaults for anything the form did not ask,
  // and nothing carried over from another person's record.
  const record: HealthRecord = { ...emptyHealthRecord(), ...input.record };
  const blob = encryptJson(record);

  const created = await prisma.healthProfile.create({
    data: {
      guestId,
      subjectName: subjectName?.trim() || null,
      subjectPhone: subjectPhone?.trim() || null,
      sourceMessageId,
      encryptedData: blob.ciphertext,
      iv: blob.iv,
      authTag: blob.authTag,
    },
    select: { id: true },
  });

  await flagDuplicateSubjects(subjectName, subjectPhone);

  await prisma.activity.create({
    data: {
      guestId,
      actorSub: "inbound-mail",
      actorRole: "system",
      actorName: "Medical screening form",
      actionType: "health_update",
      // Names the subject so a rep can see WHICH family member the form was
      // for without opening the encrypted record.
      metadata: { healthProfileId: created.id, subjectName: subjectName ?? null },
    },
  });
}

/**
 * Flag every record sharing a subject (name + phone) once there is more than
 * one of them.
 *
 * Sets the flag on the whole group rather than just the newcomer: a doctor
 * opening the FIRST record needs to know a second exists just as much, and a
 * flag on only the latest would hide the conflict behind whichever one they
 * happened to click.
 *
 * Only ever raises the flag. Clearing it is a human decision — merging or
 * deleting the extra record is what resolves it.
 */
export async function flagDuplicateSubjects(
  subjectName: string | null | undefined,
  subjectPhone: string | null | undefined,
): Promise<void> {
  const name = subjectName?.trim();
  const phone = subjectPhone?.trim();
  // With no subject there is nothing to compare — a hand-entered record is
  // about the guest and can't collide with a form.
  if (!name || !phone) return;

  const siblings = await prisma.healthProfile.findMany({
    where: { subjectPhone: phone, subjectName: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (siblings.length < 2) return;

  await prisma.healthProfile.updateMany({
    where: { id: { in: siblings.map((s) => s.id) } },
    data: { hasDuplicate: true },
  });
  logger.warn(
    { subjectName: name, count: siblings.length },
    "health-ingest: duplicate screening forms for the same person — flagged for review",
  );
}

/**
 * Clear the flag when a subject is down to a single record again — the
 * counterpart to flagDuplicateSubjects, called after a record is deleted.
 *
 * Without this, resolving a duplicate by deleting the extra record would
 * leave the survivor permanently marked as having a duplicate it no longer
 * has, and the flag would stop meaning anything.
 */
export async function unflagIfNoLongerDuplicate(
  subjectName: string | null | undefined,
  subjectPhone: string | null | undefined,
): Promise<void> {
  const name = subjectName?.trim();
  const phone = subjectPhone?.trim();
  if (!name || !phone) return;

  const siblings = await prisma.healthProfile.findMany({
    where: { subjectPhone: phone, subjectName: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (siblings.length > 1) return;

  await prisma.healthProfile.updateMany({
    where: { id: { in: siblings.map((s) => s.id) } },
    data: { hasDuplicate: false },
  });
}
