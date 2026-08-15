/**
 * GET /api/enquiries/tags — every distinct tag across ALL active leads, for
 * the Leads board's tag filter bar. Same access rule as the board itself.
 */
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { listDistinctActiveLeadTags } from "@/lib/enquiries";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view")) {
      throw new ApiError("FORBIDDEN", "No access to leads", 403);
    }
    return ok(await listDistinctActiveLeadTags());
  });
}
