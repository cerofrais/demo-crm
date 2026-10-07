/**
 * GET  /api/reports/marketing — the generated daily CSVs, newest first.
 * POST /api/reports/marketing — generate (or regenerate) one day's report.
 *
 * Gated on reports.allStaff, the same permission the rest of the org-wide
 * reporting uses, so Admin/Manager (and read-only Viewer) reach it.
 */
import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { ceoEmail, generateMarketingReport, generateRangeReport } from "@/lib/marketing-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "reports.allStaff")) {
      throw new ApiError("FORBIDDEN", "Admin/Manager only", 403);
    }

    const reports = await prisma.marketingReport.findMany({
      // generatedAt, not reportDate: a custom range has no reportDate, and
      // ordering by a nullable column would bury them.
      orderBy: { generatedAt: "desc" },
      take: 90,
    });

    return ok({
      ceoEmail: ceoEmail(),
      reports: reports.map((r) => ({
        id: r.id,
        // Null for a custom range — the client shows the window instead.
        reportDate: r.reportDate ? r.reportDate.toISOString().slice(0, 10) : null,
        rangeStart: r.rangeStart.toISOString(),
        rangeEnd: r.rangeEnd.toISOString(),
        custom: r.reportDate === null,
        filename: r.filename,
        rowCount: r.rowCount,
        sizeBytes: r.sizeBytes,
        generatedAt: r.generatedAt.toISOString(),
        emailedAt: r.emailedAt?.toISOString() ?? null,
        emailedTo: r.emailedTo,
        emailError: r.emailError,
      })),
    });
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    // Generating writes a file and can be re-run — keep it to roles that can
    // actually act on the report, not the read-only Viewer.
    if (!can(ctx.roles, "reports.allStaff") || !can(ctx.roles, "messaging.send")) {
      throw new ApiError("FORBIDDEN", "Admin/Manager only", 403);
    }

    const body = await req.json().catch(() => ({}));

    // Slugs as stored on Enquiry.tags. Capped so a hand-crafted request can't
    // turn one report into an unbounded AND across hundreds of array columns.
    const tags: string[] = Array.isArray(body?.tags)
      ? body.tags.filter((t: unknown): t is string => typeof t === "string" && t.trim().length > 0)
          .map((t: string) => t.trim())
          .slice(0, 12)
      : [];

    // Custom range: {from, to} as YYYY-MM-DD, both inclusive. Noon UTC is used
    // to name the day so neither end can slip into a neighbouring IST day.
    if (body?.from && body?.to) {
      const from = new Date(`${body.from}T12:00:00.000Z`);
      const to = new Date(`${body.to}T12:00:00.000Z`);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new ApiError("VALIDATION_ERROR", "Invalid date range", 400);
      }
      if (to < from) {
        throw new ApiError("VALIDATION_ERROR", "The end date must be on or after the start date", 400);
      }
      // A year of leads is a lot of rows to build in one request; past that,
      // the range is almost certainly a typo.
      if (to.getTime() - from.getTime() > 366 * 86_400_000) {
        throw new ApiError("VALIDATION_ERROR", "Pick a range of a year or less", 400);
      }
      return ok(await generateRangeReport(from, to, tags), undefined, 201);
    }

    // Otherwise the daily report — defaults to yesterday, matching the
    // scheduled run: today's would be incomplete while the day is still going.
    const day = body?.date ? new Date(`${body.date}T12:00:00.000Z`) : new Date(Date.now() - 86_400_000);
    if (Number.isNaN(day.getTime())) {
      throw new ApiError("VALIDATION_ERROR", "Invalid date", 400);
    }

    const result = await generateMarketingReport(day, tags);
    return ok(result, undefined, 201);
  });
}
