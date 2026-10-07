import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { encryptJson, decryptJson } from "@/lib/crypto";
import { healthRecordSchema, emptyHealthRecord, type HealthRecord } from "@/lib/health";
import { logger } from "@/lib/logger";
import { unflagIfNoLongerDuplicate } from "@/lib/health-ingest";

export const dynamic = "force-dynamic";

/**
 * Encrypted health profiles (DPDP-sensitive). Only ADMIN/DOCTOR hold the
 * `health.view` permission for reading and `health.edit` for writing — they
 * are separate so a read-only role can be shown a record without being able
 * to replace or delete one. The plaintext
 * never leaves these handlers — it's AES-256-GCM encrypted at rest and the
 * Activity log records *that* a change happened, never the contents.
 *
 * A guest can have SEVERAL records: one per screening form, because a family
 * shares a phone number and Guest.phone is unique (see HealthProfile's own
 * note). PUT and DELETE therefore address a record by `?recordId=`, and only
 * fall back to "the one record" when there is exactly one to be unambiguous
 * about. Guessing which of a family's records to overwrite is precisely the
 * bug this shape exists to prevent.
 */

/** Decrypt one row into a record, never throwing — a legacy blob that no
 *  longer matches the schema comes back empty and flagged instead. */
function decodeProfile(profile: {
  id: string;
  subjectName: string | null;
  hasDuplicate: boolean;
  updatedAt: Date;
  encryptedData: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
}): {
  id: string;
  subjectName: string | null;
  hasDuplicate: boolean;
  updatedAt: string;
  record: HealthRecord;
  schemaMismatch: boolean;
  decryptFailed: boolean;
} {
  let decrypted: unknown;
  try {
    decrypted = decryptJson({
      ciphertext: Buffer.from(profile.encryptedData),
      iv: Buffer.from(profile.iv),
      authTag: Buffer.from(profile.authTag),
    });
  } catch (err) {
    logger.error({ err, healthProfileId: profile.id }, "health decrypt failed");
    return {
      id: profile.id,
      subjectName: profile.subjectName,
      hasDuplicate: profile.hasDuplicate,
      updatedAt: profile.updatedAt.toISOString(),
      record: emptyHealthRecord(),
      schemaMismatch: false,
      decryptFailed: true,
    };
  }
  const parsed = healthRecordSchema.safeParse(decrypted);
  if (!parsed.success) {
    logger.warn(
      { healthProfileId: profile.id },
      "health record shape outdated — returning empty editable record",
    );
  }
  return {
    id: profile.id,
    subjectName: profile.subjectName,
    hasDuplicate: profile.hasDuplicate,
    updatedAt: profile.updatedAt.toISOString(),
    record: parsed.success ? parsed.data : emptyHealthRecord(),
    schemaMismatch: !parsed.success,
    decryptFailed: false,
  };
}

/**
 * Resolve which record a write targets.
 *
 * `recordId` wins. With none, exactly one record is unambiguous and zero
 * means "create". More than one and we refuse rather than pick: overwriting
 * a sibling's medical history because the caller did not say which is the
 * failure this whole model was reshaped to avoid.
 */
async function resolveTargetRecord(
  guestId: string,
  recordId: string | null,
): Promise<{ id: string } | null> {
  if (recordId) {
    const byId = await prisma.healthProfile.findFirst({
      where: { id: recordId, guestId },
      select: { id: true },
    });
    if (!byId) throw new ApiError("NOT_FOUND", "Health record not found for this guest", 404);
    return byId;
  }
  const all = await prisma.healthProfile.findMany({
    where: { guestId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (all.length === 0) return null;
  if (all.length === 1) return all[0];
  throw new ApiError(
    "AMBIGUOUS_RECORD",
    "This guest has more than one health record — say which one with ?recordId=.",
    400,
  );
}

// GET /api/guests/:id/health — every record this guest has, decrypted
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "health.view")) {
      throw new ApiError("FORBIDDEN", "Health records are Doctor/Admin only", 403);
    }
    const profiles = await prisma.healthProfile.findMany({
      where: { guestId: params.id },
      orderBy: { createdAt: "asc" },
    });

    const records = profiles.map(decodeProfile);
    // A decrypt failure is a real key/integrity problem and must not be
    // quietly rendered as an empty record the doctor might then save over.
    if (records.length && records.every((r) => r.decryptFailed)) {
      throw new ApiError(
        "DECRYPT_FAILED",
        "Could not decrypt the health record (check HEALTH_ENCRYPTION_KEY).",
        500,
      );
    }

    return ok({
      records: records.map(({ decryptFailed: _ignored, ...r }) => r),
      // Kept for callers that predate multiple records per guest; always the
      // first record, which for a single-record guest is the only one.
      exists: records.length > 0,
      record: records[0]?.record ?? emptyHealthRecord(),
      updatedAt: records[0]?.updatedAt ?? null,
      schemaMismatch: records[0]?.schemaMismatch ?? false,
    });
  });
}

// PUT /api/guests/:id/health — validate, encrypt, upsert
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    // Writing is a separate permission from reading: Viewer can open a record
    // but must not be able to replace one. These used to share health.view.
    if (!can(ctx.roles, "health.edit")) {
      throw new ApiError("FORBIDDEN", "Editing health records is Doctor/Admin only", 403);
    }

    const guest = await prisma.guest.findFirst({
      where: { id: params.id, deletedAt: null },
      select: { id: true },
    });
    if (!guest) throw new ApiError("NOT_FOUND", "Guest not found", 404);

    // Guard against silently overwriting a legacy record that no longer matches
    // the schema. In that case GET returns an EMPTY editable record (schemaMismatch),
    // so a naive Save would replace the old encrypted blob with blank defaults and
    // there is no versioning. Refuse unless the client explicitly acknowledges.
    const recordId = req.nextUrl.searchParams.get("recordId");
    const target = await resolveTargetRecord(params.id, recordId);
    const existing = target
      ? await prisma.healthProfile.findUnique({ where: { id: target.id } })
      : null;
    if (existing) {
      let existingParsesOk = false;
      try {
        const dec = decryptJson({
          ciphertext: Buffer.from(existing.encryptedData),
          iv: Buffer.from(existing.iv),
          authTag: Buffer.from(existing.authTag),
        });
        existingParsesOk = healthRecordSchema.safeParse(dec).success;
      } catch {
        existingParsesOk = false;
      }
      const acknowledged =
        req.nextUrl.searchParams.get("acknowledgeSchemaMismatch") === "true";
      if (!existingParsesOk && !acknowledged) {
        throw new ApiError(
          "SCHEMA_MIGRATION_REQUIRED",
          "This health record was saved in an older format. Review it and confirm before replacing it.",
          409,
        );
      }
    }

    const record = healthRecordSchema.parse(await req.json());
    const blob = encryptJson(record);

    // Update the record we resolved above, or start a doctor-entered one.
    // A record created here has no subject: it is about the guest, unlike a
    // form submission which names whoever it was filled in for.
    const saved = target
      ? await prisma.healthProfile.update({
          where: { id: target.id },
          data: { encryptedData: blob.ciphertext, iv: blob.iv, authTag: blob.authTag },
          select: { id: true },
        })
      : await prisma.healthProfile.create({
          data: {
            guestId: params.id,
            encryptedData: blob.ciphertext,
            iv: blob.iv,
            authTag: blob.authTag,
          },
          select: { id: true },
        });

    await prisma.activity.create({
      data: {
        guestId: params.id,
        actorSub: ctx.sub,
        actorRole: ctx.roles[0] ?? "DOCTOR",
        actorName: ctx.name,
        actionType: "health_update",
        metadata: { healthProfileId: saved.id }, // never log health contents
      },
    });

    return ok({ saved: true, recordId: saved.id, updatedAt: new Date().toISOString() });
  });
}

// DELETE /api/guests/:id/health — remove one encrypted health record
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "health.edit")) {
      throw new ApiError("FORBIDDEN", "Deleting health records is Doctor/Admin only", 403);
    }

    const target = await resolveTargetRecord(params.id, _req.nextUrl.searchParams.get("recordId"));
    if (!target) return ok({ deleted: false });

    const removed = await prisma.healthProfile.delete({
      where: { id: target.id },
      select: { subjectName: true, subjectPhone: true },
    });
    // Deleting one of a duplicate pair may leave the survivor alone, in which
    // case its flag is now a lie. Recomputed rather than left stale.
    await unflagIfNoLongerDuplicate(removed.subjectName, removed.subjectPhone);

    await prisma.activity.create({
      data: {
        guestId: params.id,
        actorSub: ctx.sub,
        actorRole: ctx.roles[0] ?? "DOCTOR",
        actorName: ctx.name,
        actionType: "health_deleted",
        metadata: {}, // never log health contents
      },
    });

    return ok({ deleted: true });
  });
}
