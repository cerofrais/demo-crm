/**
 * POST /api/reports/marketing/:id/email — send a generated report to the CEO
 * (MARKETING_REPORT_TO, default ceo@trewellness.in) as a CSV attachment.
 *
 * Sending is outward-facing, so it needs messaging.send on top of the
 * reporting permission — a read-only Viewer can open the Marketing page and
 * download a report, but can't mail one out.
 */
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { NextResponse } from "next/server";
import { emailMarketingReport } from "@/lib/marketing-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const asNext = (r: Response) => new NextResponse(r.body, { status: r.status, headers: r.headers });

export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "reports.allStaff") || !can(ctx.roles, "messaging.send")) {
      throw new ApiError("FORBIDDEN", "Admin/Manager only", 403);
    }

    // The CEO shouldn't get the same report twenty times because someone
    // leaned on the button.
    const rl = await rateLimit({ key: `marketing-report-email:${params.id}`, limit: 3, windowSec: 300 });
    if (!rl.allowed) return asNext(rateLimitResponse(rl));

    const result = await emailMarketingReport(params.id);
    return ok(result);
  });
}
