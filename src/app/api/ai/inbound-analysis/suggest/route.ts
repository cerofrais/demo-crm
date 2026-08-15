/**
 * POST /api/ai/inbound-analysis/suggest — draft a reply template for one topic
 * from the real questions guests asked about it.
 *
 * The only model call in this feature. Audited as an AiDecision
 * (kind template_suggestion) like every other, so the prompt and output are
 * reviewable on the same page that produced them.
 *
 * Drafting only: nothing is saved to the template library here. A human reads
 * it, edits the placeholders, and saves it from Message Templates — a model
 * shouldn't be writing directly into what reps send to guests.
 */
import { NextRequest, NextResponse } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { aiFeatureEnabled } from "@/lib/ai/config";
import { suggestTemplate } from "@/lib/ai/inbound-analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const asNext = (r: Response) => new NextResponse(r.body, { status: r.status, headers: r.headers });

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "ai.audit")) {
      throw new ApiError("FORBIDDEN", "No access to the AI audit log", 403);
    }
    if (!aiFeatureEnabled("assist")) {
      throw new ApiError("AI_DISABLED", "AI drafting is not enabled on this server", 503);
    }

    const rl = await rateLimit({ key: `template-suggest:${ctx.sub}`, limit: 20, windowSec: 3600 });
    if (!rl.allowed) return asNext(rateLimitResponse(rl));

    const body = await req.json().catch(() => ({}));
    const topic = typeof body?.topic === "string" ? body.topic : "";
    const examples: string[] = Array.isArray(body?.examples)
      ? body.examples.filter((e: unknown): e is string => typeof e === "string").slice(0, 25)
      : [];

    if (!topic) throw new ApiError("VALIDATION_ERROR", "A topic is required", 400);
    if (!examples.length) {
      throw new ApiError("VALIDATION_ERROR", "No example messages for this topic", 400);
    }

    const suggestion = await suggestTemplate(topic, examples, ctx.sub, ctx.name);
    return ok(suggestion);
  });
}
