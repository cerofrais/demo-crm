/**
 * GET /api/broadcast-status — list bulk WhatsApp broadcast triggers (most
 * recent first), for the Broadcast Status page. Same audience as who can
 * start a broadcast (messaging.send) — everyone who can trigger one should
 * be able to see how past ones landed. Soft-deleted triggers are excluded;
 * deleting one only hides it from this list — see the [id] route.
 */
import { handle, ok, requirePermission } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { getStaffNamesBatch } from "@/lib/enquiries";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    await requirePermission("messaging.broadcast");

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
        delaySec: j.delaySec,
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
