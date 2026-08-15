/**
 * GET /api/deleted-leads/tags — every distinct tag sitting on a soft-deleted
 * lead, for the archive's tag filter bar. Same gate as the rest of Deleted
 * Leads — see route.ts's comment.
 */
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { listDistinctDeletedLeadTags } from "@/lib/deleted-leads";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.delete")) {
      throw new ApiError("FORBIDDEN", "Admin only", 403);
    }
    return ok(await listDistinctDeletedLeadTags());
  });
}
