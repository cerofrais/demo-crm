/**
 * GET /api/ai/decisions — paginated AI/ML decision audit log (admin only).
 * Query params: kind, success (true|false), from, to, cursor.
 */
import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { listAiDecisions, aiDecisionStats, type AiDecisionFilters } from "@/lib/ai-decisions";
import type { AiDecisionKind } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "ai.audit")) {
      throw new ApiError("FORBIDDEN", "No access to the AI audit log", 403);
    }

    const sp = req.nextUrl.searchParams;
    const filters: AiDecisionFilters = {
      kind: (sp.get("kind") as AiDecisionKind) || undefined,
      cursor: sp.get("cursor") ?? undefined,
    };
    const successParam = sp.get("success");
    if (successParam === "true") filters.success = true;
    if (successParam === "false") filters.success = false;
    const from = sp.get("from");
    const to = sp.get("to");
    if (from) filters.dateFrom = new Date(from);
    if (to) filters.dateTo = new Date(to);

    const data = await listAiDecisions(filters);
    const stats = await aiDecisionStats();
    return ok(data, { stats });
  });
}
