/**
 * GET /api/broadcast-status — list bulk WhatsApp broadcast triggers (most
 * recent first), for the Broadcast Status page. Gated on messaging.viewStatus
 * (Admin/Manager/Viewer) — starting a broadcast and reviewing every campaign
 * the org has ever run are different powers, and only the second is this
 * page. Soft-deleted triggers are excluded; deleting one only hides it from
 * this list — see the [id] route.
 */
import { handle, ok, requirePermission } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { getStaffNamesBatch } from "@/lib/enquiries";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    await requirePermission("messaging.viewStatus");

    const jobs = await prisma.broadcastJob.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    const numberIds = jobs.flatMap((j) => (j.numberId ? [j.numberId] : []));
    const numbers = numberIds.length
      ? await prisma.whatsAppNumber.findMany({
          where: { id: { in: numberIds } },
          select: { id: true, label: true },
        })
      : [];
    const numberLabelById = new Map(numbers.map((n) => [n.id, n.label]));

    const namesBySub = await getStaffNamesBatch(jobs.map((j) => j.createdBySub));

    return ok(
      jobs.map((j) => ({
        id: j.id,
        status: j.status,
        message: j.message,
        templateName: j.templateName,
        templateCategory: j.templateCategory,
        // Which Meta endpoint this job actually went out over — needed to
        // compare delivery between the two paths after the fact.
        usedMarketingApi: j.usedMarketingApi,
        numberLabel: j.numberId ? (numberLabelById.get(j.numberId) ?? "Unknown number") : "Org default",
        // Needed by the follow-up dialog to load that number's approved
        // templates; null means the job used the org default number.
        numberId: j.numberId,
        delaySec: j.delaySec,
        scheduledAt: j.scheduledAt?.toISOString() ?? null,
        followUpOfJobId: j.followUpOfJobId,
        // A rolling follow-up re-arms its scheduledAt every 15 minutes while
        // it waits, so scheduledAt alone would read as a countdown that never
        // ends. This is the date the chase actually stops.
        followUpRollingUntil: j.followUpRollingUntil?.toISOString() ?? null,
        replyTag: j.replyTag,
        totalCount: j.totalCount,
        sentCount: j.sentCount,
        failedCount: j.failedCount,
        cursor: j.cursor,
        createdBySub: j.createdBySub,
        createdByName: namesBySub.get(j.createdBySub) ?? "Unknown",
        createdAt: j.createdAt.toISOString(),
        completedAt: j.completedAt?.toISOString() ?? null,
      })),
    );
  });
}
