import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { encryptJson, decryptJson } from "@/lib/crypto";
import { healthRecordSchema, emptyHealthRecord, type HealthRecord } from "@/lib/health";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Encrypted health profile (DPDP-sensitive). Only ADMIN/DOCTOR hold the
 * `health.view` permission, which gates both read and write here. The plaintext
 * never leaves these handlers — it's AES-256-GCM encrypted at rest and the
 * Activity log records *that* a change happened, never the contents.
 */

// GET /api/guests/:id/health — decrypt & return (or an empty record)
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "health.view")) {
      throw new ApiError("FORBIDDEN", "Health records are Doctor/Admin only", 403);
    }
    const profile = await prisma.healthProfile.findUnique({
      where: { guestId: params.id },
    });

    if (!profile) {
      return ok({ exists: false, record: emptyHealthRecord(), updatedAt: null });
    }

    // 1) Decrypt (a failure here is a real key/integrity problem).
    let decrypted: unknown;
    try {
      decrypted = decryptJson({
        ciphertext: Buffer.from(profile.encryptedData),
        iv: Buffer.from(profile.iv),
        authTag: Buffer.from(profile.authTag),
      });
    } catch (err) {
      logger.error({ err, guestId: params.id }, "health decrypt failed");
      throw new ApiError(
        "DECRYPT_FAILED",
        "Could not decrypt the health record (check HEALTH_ENCRYPTION_KEY).",
        500,
      );
    }

    // 2) Parse against the current schema. If a legacy record doesn't match,
    //    fall back to an empty record (never throw) and flag it for the editor.
    const parsed = healthRecordSchema.safeParse(decrypted);
    if (!parsed.success) {
      logger.warn(
        { guestId: params.id },
        "health record shape outdated — returning empty editable record",
      );
    }
    const record: HealthRecord = parsed.success ? parsed.data : emptyHealthRecord();

    return ok({
      exists: true,
      record,
      updatedAt: profile.updatedAt.toISOString(),
      schemaMismatch: !parsed.success,
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
    if (!can(ctx.roles, "health.view")) {
      throw new ApiError("FORBIDDEN", "Health records are Doctor/Admin only", 403);
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
    const existing = await prisma.healthProfile.findUnique({
      where: { guestId: params.id },
    });
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

    await prisma.healthProfile.upsert({
      where: { guestId: params.id },
      update: { encryptedData: blob.ciphertext, iv: blob.iv, authTag: blob.authTag },
      create: {
        guestId: params.id,
        encryptedData: blob.ciphertext,
        iv: blob.iv,
        authTag: blob.authTag,
      },
    });

    await prisma.activity.create({
      data: {
        guestId: params.id,
        actorSub: ctx.sub,
        actorRole: ctx.roles[0] ?? "DOCTOR",
        actorName: ctx.name,
        actionType: "health_update",
        metadata: {}, // never log health contents
      },
    });

    return ok({ saved: true, updatedAt: new Date().toISOString() });
  });
}

// DELETE /api/guests/:id/health — remove the encrypted health record entirely
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "health.view")) {
      throw new ApiError("FORBIDDEN", "Health records are Doctor/Admin only", 403);
    }

    const existing = await prisma.healthProfile.findUnique({
      where: { guestId: params.id },
    });
    if (!existing) return ok({ deleted: false });

    await prisma.healthProfile.delete({ where: { guestId: params.id } });

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
