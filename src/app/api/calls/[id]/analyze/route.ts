/**
 * POST /api/calls/[id]/analyze — trigger AI analysis for one call.
 * Re-analyses when called on an already-analysed call (manual = intentional).
 */
import { NextRequest, NextResponse } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { aiFeatureEnabled } from "@/lib/ai/config";
import { analyzeCall } from "@/lib/ai/call-analysis";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// F20 — this endpoint force re-analyses (fresh LLM + transcription spend) on
// every call. Cool down repeat analysis of the same call, and cap per user.
const ANALYZE_COOLDOWN_SEC = Number(process.env.AI_ANALYZE_COOLDOWN_SEC ?? 600);
const ANALYZE_PER_MIN = Number(process.env.AI_ANALYZE_PER_MIN ?? 10);

const asNext = (r: Response) => new NextResponse(r.body, { status: r.status, headers: r.headers });

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view")) {
      throw new ApiError("FORBIDDEN", "No access to calls", 403);
    }
    if (!aiFeatureEnabled("callAnalysis")) {
      throw new ApiError("AI_DISABLED", "AI call analysis is not enabled on this server", 503);
    }

    // Per-call cooldown: refuse a re-analyse within ANALYZE_COOLDOWN_SEC of the
    // last (limit 1 per window keyed on the call id).
    const cooldown = await rateLimit({
      key: `ai-analyze:call:${params.id}`,
      limit: 1,
      windowSec: ANALYZE_COOLDOWN_SEC,
    });
    if (!cooldown.allowed) return asNext(rateLimitResponse(cooldown));
    // Per-user burst cap across distinct calls.
    const userLimit = await rateLimit({ key: `ai-analyze:user:${ctx.sub}`, limit: ANALYZE_PER_MIN, windowSec: 60 });
    if (!userLimit.allowed) return asNext(rateLimitResponse(userLimit));

    const skipped = await analyzeCall(params.id, true, ctx.sub, ctx.name);
    if (skipped) throw new ApiError("UNPROCESSABLE", `Cannot analyse: ${skipped}`, 422);

    const call = await prisma.call.findUnique({
      where: { id: params.id },
      select: {
        id: true, aiSummary: true, aiScore: true, aiTags: true,
        aiSuggestions: true, aiAnalyzedAt: true, transcript: true,
        transcriptEnglish: true, transcriptLanguage: true,
      },
    });
    return ok(call);
  });
}
