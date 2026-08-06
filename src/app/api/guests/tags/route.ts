import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/guests/tags — every distinct tag currently applied to a
 * non-deleted guest, for the Guests page's tag filter bar. Deliberately
 * scans actual guest tags rather than the shared /api/tags vocabulary,
 * which also carries lead-only tags (age/source/campaign) that would show
 * up as a filter chip matching zero guests.
 */
export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "guests.view") && !can(ctx.roles, "health.view")) {
      throw new ApiError("FORBIDDEN", "No access", 403);
    }
    const rows = await prisma.$queryRaw<{ tag: string }[]>`
      SELECT DISTINCT unnest(tags) AS tag FROM "Guest" WHERE "deletedAt" IS NULL ORDER BY tag
    `;
    return ok(rows.map((r) => r.tag));
  });
}
