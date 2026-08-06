import { prisma } from "./prisma";
import { logger } from "./logger";

export async function getLeadDeletionSettings(): Promise<{ autoDeleteDays: number }> {
  const row = await prisma.leadDeletionSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
  return { autoDeleteDays: row.autoDeleteDays };
}

export async function setLeadDeletionSettings(autoDeleteDays: number): Promise<{ autoDeleteDays: number }> {
  const row = await prisma.leadDeletionSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", autoDeleteDays },
    update: { autoDeleteDays },
  });
  return { autoDeleteDays: row.autoDeleteDays };
}

/**
 * Soft-deletes every Dead lead that's been sitting in Lost/Dead for more than
 * autoDeleteDays, counted from the moment it entered that stage (Enquiry.lostAt
 * — see the stage-transition routes). No approval step. Reads the day count
 * fresh on every run (DB-driven, not cached at process start) so an admin's
 * change takes effect on the next tick. Leads already in Lost/Dead before
 * lostAt existed have it as null and are never matched — they're never
 * retroactively swept, only leads that enter Lost going forward are.
 */
export async function runDeletionSweep(): Promise<void> {
  const { autoDeleteDays } = await getLeadDeletionSettings();
  const cutoff = new Date(Date.now() - autoDeleteDays * 24 * 60 * 60 * 1000);

  const due = await prisma.enquiry.findMany({
    where: {
      stage: "lost",
      deletedAt: null,
      lostAt: { lte: cutoff },
    },
    select: { id: true, guestId: true },
  });
  if (!due.length) return;

  for (const enquiry of due) {
    try {
      await prisma.enquiry.update({
        where: { id: enquiry.id },
        data: { deletedAt: new Date() },
      });
      await prisma.activity.create({
        data: {
          enquiryId: enquiry.id,
          guestId: enquiry.guestId,
          actorSub: "system",
          actorRole: "system",
          actorName: "Auto-delete sweep",
          actionType: "auto_deleted",
          metadata: { autoDeleteDays },
        },
      });
    } catch (err) {
      logger.error({ err, enquiryId: enquiry.id }, "deletion sweep: failed to soft-delete lead");
    }
  }
  logger.info({ count: due.length, autoDeleteDays }, "deletion sweep: soft-deleted approved dead leads");
}
