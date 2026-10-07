/**
 * GET /api/reports/cresent?week=YYYY-MM-DD | from=YYYY-MM-DD&to=YYYY-MM-DD
 *                          [&tags=a,b][&format=csv]
 *
 * The Cresent report for one week or any range of days, built live. Tags default to the saved ones, so
 * the page can preview an unsaved selection without touching the schedule.
 * Same gate as the rest of org-wide reporting.
 */
import { NextRequest, NextResponse } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { buildCresentReport, cresentCsv, getCresentSettings } from "@/lib/cresent-report";
import { parseRangeParams } from "@/lib/cresent-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "reports.allStaff")) throw new ApiError("FORBIDDEN", "Admin/Manager only", 403);

    const sp = req.nextUrl.searchParams;
    const range = parseRangeParams({ week: sp.get("week"), from: sp.get("from"), to: sp.get("to") });
    if ("error" in range) throw new ApiError("VALIDATION_ERROR", range.error, 400);

    const tags = sp.has("tags")
      ? (sp.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 30)
      : (await getCresentSettings()).tags;

    const report = await buildCresentReport(range, tags);
    if (sp.get("format") !== "csv") return ok(report);

    const csv = cresentCsv(report);
    return new NextResponse(csv.content, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csv.filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  });
}
