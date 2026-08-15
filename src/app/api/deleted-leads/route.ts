/**
 * GET /api/deleted-leads — admin-only archive of soft-deleted leads.
 *
 * Gated on `leads.delete`, which only ADMIN holds: whoever can delete a lead
 * is who may read one back. Deliberately not `reports.allStaff` (that includes
 * MANAGER), since a deleted lead's archive exposes the full message/call
 * history of a record someone chose to remove from the pipeline.
 */
import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { listDeletedLeads } from "@/lib/deleted-leads";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.delete")) {
      throw new ApiError("FORBIDDEN", "Admin only", 403);
    }

    const sp = req.nextUrl.searchParams;
    const result = await listDeletedLeads(
      {
        q: sp.get("q") ?? undefined,
        from: sp.get("from") ?? undefined,
        to: sp.get("to") ?? undefined,
        source: sp.get("source") ?? undefined,
        tags: sp.get("tags")?.split(",").map((t) => t.trim()).filter(Boolean),
      },
      25,
      sp.get("cursor") ?? undefined,
    );
    return ok(result);
  });
}
