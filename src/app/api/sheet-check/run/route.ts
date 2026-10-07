/**
 * POST /api/sheet-check/run {dryRun} — run the check now.
 * dryRun: report only — nothing pushed or emailed, watermark untouched.
 * Otherwise a full run, the same as the scheduled one.
 */
import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { runSheetCheck } from "@/lib/sheet-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.manage")) throw new ApiError("FORBIDDEN", "Admin/Manager only", 403);
    const body = await req.json().catch(() => ({}));
    try {
      return ok(await runSheetCheck({ trigger: "manual", dryRun: body?.dryRun !== false, actorSub: ctx.sub }));
    } catch (err) {
      throw new ApiError("CHECK_FAILED", err instanceof Error ? err.message : "Sheet check failed", 400);
    }
  });
}
