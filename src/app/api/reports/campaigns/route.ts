/**
 * GET /api/reports/campaigns — distinct campaign labels in use, for the
 * Reports page's campaign filter autocomplete.
 */
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "reports.own")) {
      throw new ApiError("FORBIDDEN", "No access to reports", 403);
    }
    const rows = await prisma.enquiry.findMany({
      where: { campaignLabel: { not: null } },
      select: { campaignLabel: true },
      distinct: ["campaignLabel"],
      orderBy: { campaignLabel: "asc" },
    });
    return ok(rows.map((r) => r.campaignLabel).filter((c): c is string => !!c));
  });
}
