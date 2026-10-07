/**
 * GET /api/calls/tags — every distinct tag on a lead that has at least one
 * call, for the Calls page's tag filter bar.
 *
 * Separate from the call list for the same reason as /api/tasks/tags: tag
 * filtering is server-side, so deriving the picker from the filtered calls
 * would shrink it to the tags already chosen. Names only, same vocabulary the
 * leads board shows, so it isn't scoped per viewer.
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
        AND EXISTS (SELECT 1 FROM "Call" c WHERE c."enquiryId" = e.id)
      ORDER BY tag
    `;
    return ok(rows.map((r) => r.tag));
  });
}
