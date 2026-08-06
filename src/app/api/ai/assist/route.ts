/**
 * POST /api/ai/assist { enquiryId } — conversation helper: summarise the
 * lead's situation, suggest next actions, and draft a reply.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { aiFeatureEnabled } from "@/lib/ai/config";
import { getAssist } from "@/lib/ai/assistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const schema = z.object({ enquiryId: z.string().min(1) });

// F20 — per-user ceilings so one user can't burn unbounded LLM spend. Env-
// overridable; defaults are generous for interactive use.
const ASSIST_PER_MIN = Number(process.env.AI_ASSIST_PER_MIN ?? 20);
const ASSIST_PER_DAY = Number(process.env.AI_ASSIST_PER_DAY ?? 500);

// rateLimitResponse returns a plain Response; wrap it so it satisfies handle()'s
// NextResponse return type without losing the 429 body/headers.
const asNext = (r: Response) => new NextResponse(r.body, { status: r.status, headers: r.headers });

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view")) {
      throw new ApiError("FORBIDDEN", "No access to leads", 403);
    }
    if (!aiFeatureEnabled("assist")) {
      throw new ApiError("AI_DISABLED", "AI assist is not enabled on this server", 503);
    }
    const { enquiryId } = schema.parse(await req.json());

    // F19 — ownership check (mirrors enquiries/[id]): without this any leads.view
    // holder could run the LLM against any lead (IDOR + billing pivot).
    const enquiry = await prisma.enquiry.findUnique({
      where: { id: enquiryId },
      select: { assignedToSub: true },
    });
    if (!enquiry) throw new ApiError("NOT_FOUND", "Enquiry not found", 404);
    const allowed =
      can(ctx.roles, "leads.manage") ||
      (can(ctx.roles, "leads.ownOnly") && enquiry.assignedToSub === ctx.sub);
    if (!allowed) throw new ApiError("FORBIDDEN", "Cannot access this lead", 403);

    // F20 — meter per user: short burst window AND a daily cap.
    const minLimit = await rateLimit({ key: `ai-assist:min:${ctx.sub}`, limit: ASSIST_PER_MIN, windowSec: 60 });
    if (!minLimit.allowed) return asNext(rateLimitResponse(minLimit));
    const dayLimit = await rateLimit({ key: `ai-assist:day:${ctx.sub}`, limit: ASSIST_PER_DAY, windowSec: 86_400 });
    if (!dayLimit.allowed) return asNext(rateLimitResponse(dayLimit));

    const result = await getAssist(enquiryId, ctx.name ?? "The Trē Wellness team", ctx.sub);
    return ok(result);
  });
}
