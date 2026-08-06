import { prisma } from "./prisma";
import { encryptJson, decryptJson } from "./crypto";
import { logger } from "./logger";
import { healthRecordSchema, emptyHealthRecord, type HealthRecord } from "./health";

/**
 * System-actor (no session/RBAC) writes for auto-ingested health data (the
 * medical-screening-form email poller — see medical-form-parser.ts). Unlike
 * the doctor-facing PUT /api/guests/:id/health, which always replaces the
 * whole record, this only ever backfills fields that are still at their
 * schema default — anything a doctor has already entered or corrected by
 * hand is left untouched, on the theory that a still-default field is one
 * nobody has looked at yet, and a non-default one has been.
 */

function isDefaultValue(key: keyof HealthRecord, value: unknown, defaults: HealthRecord): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object" && value !== null && "flag" in value) {
    const v = value as { flag: boolean; detail: string };
    const d = defaults[key] as { flag: boolean; detail: string };
    return v.flag === d.flag && v.detail === "";
  }
  if (typeof value === "boolean") return value === defaults[key];
  if (typeof value === "string") return value === "";
  return value == null;
}

/** Pure merge, exported for testing — only overwrites a field in `existing`
 *  when that field is still at its schema default AND `incoming` supplies a
 *  non-default value for it. */
export function backfillHealthRecord(
  existing: HealthRecord,
  incoming: Partial<HealthRecord>,
): { merged: HealthRecord; changed: boolean } {
  const defaults = emptyHealthRecord();
  const merged: HealthRecord = { ...existing };
  let changed = false;

  for (const key of Object.keys(incoming) as (keyof HealthRecord)[]) {
    const incomingValue = incoming[key];
    if (incomingValue === undefined) continue;
    if (!isDefaultValue(key, existing[key], defaults)) continue; // doctor already touched this field
    if (isDefaultValue(key, incomingValue, defaults)) continue; // nothing new to add either

    (merged as Record<string, unknown>)[key] = incomingValue;
    changed = true;
  }

  return { merged, changed };
}

/** Decrypts the existing record if present, defensively falling back to an
 *  empty one on a schema mismatch or decrypt failure — same fallback the
 *  doctor-facing GET route uses, never throws. */
async function loadExistingHealthRecord(guestId: string): Promise<HealthRecord> {
  const profile = await prisma.healthProfile.findUnique({ where: { guestId } });
  if (!profile) return emptyHealthRecord();
  try {
    const decrypted = decryptJson({
      ciphertext: Buffer.from(profile.encryptedData),
      iv: Buffer.from(profile.iv),
      authTag: Buffer.from(profile.authTag),
    });
    const parsed = healthRecordSchema.safeParse(decrypted);
    return parsed.success ? parsed.data : emptyHealthRecord();
  } catch (err) {
    logger.error({ err, guestId }, "health-ingest: decrypt failed, treating as empty");
    return emptyHealthRecord();
  }
}

/**
 * Backfills `incoming` onto the guest's health record (creating one if none
 * exists yet) and logs the same "health_update" activity the doctor-facing
 * editor logs — content is never included, matching that route's own
 * "never log health contents" rule. No-ops (no write, no activity) if
 * nothing actually changed, e.g. a guest re-submitting the same form twice.
 */
export async function upsertHealthRecordBackfill(
  guestId: string,
  incoming: Partial<HealthRecord>,
): Promise<void> {
  const existing = await loadExistingHealthRecord(guestId);
  const { merged, changed } = backfillHealthRecord(existing, incoming);
  if (!changed) return;

  const blob = encryptJson(merged);
  await prisma.healthProfile.upsert({
    where: { guestId },
    update: { encryptedData: blob.ciphertext, iv: blob.iv, authTag: blob.authTag },
    create: { guestId, encryptedData: blob.ciphertext, iv: blob.iv, authTag: blob.authTag },
  });

  await prisma.activity.create({
    data: {
      guestId,
      actorSub: "inbound-mail",
      actorRole: "system",
      actorName: "Medical screening form",
      actionType: "health_update",
      metadata: {},
    },
  });
}
