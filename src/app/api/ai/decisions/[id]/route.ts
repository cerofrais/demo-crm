/**
 * GET /api/ai/decisions/:id — full detail (prompt + output) for one decision.
 * Admin only — this can contain sensitive content (health notes, email bodies).
 */
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { getAiDecision } from "@/lib/ai-decisions";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "ai.audit")) {
      throw new ApiError("FORBIDDEN", "No access to the AI audit log", 403);
    }
    const decision = await getAiDecision(params.id);
    if (!decision) throw new ApiError("NOT_FOUND", "Decision not found", 404);
    return ok(decision);
  });
}
