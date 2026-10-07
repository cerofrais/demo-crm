/**
 * POST /api/reports/cresent/send {week} | {from, to} — email the report now, to the
 * saved recipients with the saved tags. Doesn't take the scheduled slot, so
 * the Monday send still goes out.
 */
import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { getCresentSettings, sendCresentReport } from "@/lib/cresent-report";
import { parseRangeParams } from "@/lib/cresent-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "reports.allStaff") || !can(ctx.roles, "messaging.send")) {
      throw new ApiError("FORBIDDEN", "Admin/Manager only", 403);
    }
    const body = await req.json().catch(() => ({}));
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    if (!str(body?.week) && !(str(body?.from) && str(body?.to))) {
      throw new ApiError("VALIDATION_ERROR", "Pick a week or a date range to send", 400);
    }
    const range = parseRangeParams({ week: str(body?.week), from: str(body?.from), to: str(body?.to) });
    if ("error" in range) throw new ApiError("VALIDATION_ERROR", range.error, 400);

    const settings = await getCresentSettings();
    try {
      return ok(
        await sendCresentReport({ start: range.start, end: range.end, recipients: settings.recipients, tags: settings.tags, actorSub: ctx.sub }),
      );
    } catch (err) {
      if (err instanceof Error && /at least one|isn't configured/.test(err.message)) {
        throw new ApiError("VALIDATION_ERROR", err.message, 400);
      }
      throw err;
    }
  });
}
