/**
 * GET /api/ai/inbound-analysis?days=90 — what guests are asking, grouped into
 * recurring topics, with the template library cross-referenced so the gaps
 * are visible.
 *
 * No model call: the grouping is deterministic (see lib/ai/inbound-analysis.ts).
 * Drafting a template from a topic is the separate POST below.
 */
import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { analyseInbound } from "@/lib/ai/inbound-analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    // Same gate as the rest of the AI Audit page — this reads guest message
    // content, so it stays with the roles already trusted with the audit log.
    if (!can(ctx.roles, "ai.audit")) {
      throw new ApiError("FORBIDDEN", "No access to the AI audit log", 403);
    }

    const sp = req.nextUrl.searchParams;
    const days = Math.min(Math.max(Number(sp.get("days") ?? 90), 1), 730);
    const to = sp.get("to") ? new Date(`${sp.get("to")}T23:59:59.999Z`) : new Date();
    const from = sp.get("from")
      ? new Date(`${sp.get("from")}T00:00:00.000Z`)
      : new Date(to.getTime() - days * 86_400_000);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      throw new ApiError("VALIDATION_ERROR", "Invalid date range", 400);
    }

    return ok(await analyseInbound(from, to));
  });
}
