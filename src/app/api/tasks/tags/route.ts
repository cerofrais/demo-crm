/**
 * GET /api/tasks/tags — every distinct tag sitting on a lead that currently
 * has an open task, for the Tasks page's tag filter bar.
 *
 * Deliberately a separate call rather than deriving the list from the loaded
 * tasks: tag filtering is applied server-side, so once a tag is active the
 * task response only contains matching rows — deriving from it would collapse
 * the picker to the tags you already chose and strand you there.
 *
 * Not scoped per-viewer. The list is only tag NAMES (no guest, no lead, no
 * counts), it's the same vocabulary every leads-board user already browses,
 * and scoping it would make the picker's contents depend on whose tasks are
 * open — surprising, and no more private.
 */
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view")) throw new ApiError("FORBIDDEN", "No access", 403);

    const rows = await prisma.$queryRaw<{ tag: string }[]>`
      SELECT DISTINCT unnest(e.tags) AS tag
      FROM "Enquiry" e
      WHERE e."deletedAt" IS NULL
        AND EXISTS (
          SELECT 1 FROM "Task" t
          WHERE t."enquiryId" = e.id AND t.status = 'open'
        )
      ORDER BY tag
    `;
    return ok(rows.map((r) => r.tag));
  });
}
