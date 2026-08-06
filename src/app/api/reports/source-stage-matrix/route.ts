import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { resolveReportRange } from "@/lib/report-range";

export const dynamic = "force-dynamic";

/**
 * Source x stage matrix — leads CREATED within the picked range, broken down
 * by their CURRENT stage. There's no stage-history log, so "stage as of a
 * past date" isn't something we can answer; filtering on creation date and
 * showing where those leads stand today is the only sound reading of "this
 * matrix, for this date range." Same unscoped-by-staff shape as before this
 * filter existed — every role with reports.own sees the full org matrix.
 */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "reports.own")) {
      throw new ApiError("FORBIDDEN", "No access to reports", 403);
    }
    const { start, end, period } = resolveReportRange(req.nextUrl.searchParams);

    // Same optional campaign/source narrowing as the Performance table —
    // "source" here just adds an extra equality filter on top of the
    // group-by-source itself (e.g. isolate one campaign's stage spread
    // without changing the source breakdown).
    const source = req.nextUrl.searchParams.get("source") || undefined;
    const campaignLabel = req.nextUrl.searchParams.get("campaignLabel")?.trim() || undefined;

    const grouped = await prisma.enquiry.groupBy({
      by: ["source", "stage"],
      where: {
        createdAt: { gte: start, lte: end },
        ...(source && { source: source as Prisma.EnquiryWhereInput["source"] }),
        ...(campaignLabel && { campaignLabel: { contains: campaignLabel, mode: "insensitive" } }),
      },
      _count: true,
    });

    return ok(
      grouped.map((g) => ({ source: g.source, stage: g.stage, count: g._count })),
      { period, startDate: start.toISOString(), endDate: end.toISOString() },
    );
  });
}
