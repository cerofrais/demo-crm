/**
 * POST /api/ai/pipeline — manually run one AI pipeline tick (admin/manager).
 * Useful for demos and after seeding; the background interval does this on
 * its own every AI_PIPELINE_INTERVAL_SEC.
 */
import { NextResponse } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { aiEnabled } from "@/lib/ai/config";
import { runAiPipeline } from "@/lib/ai/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// F20 — a full pipeline tick fans out many LLM calls; cap manual runs per user.
const PIPELINE_PER_HOUR = Number(process.env.AI_PIPELINE_RUNS_PER_HOUR ?? 5);

// rateLimitResponse returns a plain Response; wrap it for handle()'s NextResponse.
const asNext = (r: Response) => new NextResponse(r.body, { status: r.status, headers: r.headers });

export async function POST() {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "reports.allStaff")) {
      throw new ApiError("FORBIDDEN", "Admin/manager only", 403);
    }
    if (!aiEnabled()) {
      throw new ApiError("AI_DISABLED", "AI is not enabled on this server", 503);
    }
    const rl = await rateLimit({ key: `ai-pipeline:${ctx.sub}`, limit: PIPELINE_PER_HOUR, windowSec: 3600 });
    if (!rl.allowed) return asNext(rateLimitResponse(rl));

    const summary = await runAiPipeline();
    return ok(summary);
  });
}
