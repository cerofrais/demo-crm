/**
 * GET /api/reports/activity — paginated, filterable staff activity feed
 * (admin/manager only). Query params: actorSub, actionType, fromNumber, from,
 * to, cursor.
 */
import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { listActivity, type ActivityFilters, parseActionTypeFilter } from "@/lib/activity-log";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "reports.allStaff")) {
      throw new ApiError("FORBIDDEN", "No access to the activity log", 403);
    }

    const sp = req.nextUrl.searchParams;
    const filters: ActivityFilters = {
      actorSub: sp.get("actorSub") || undefined,
      ...parseActionTypeFilter(sp.get("actionType")),
      // E.164 only; anything else is ignored rather than matched loosely.
      fromNumber: /^\+\d{8,15}$/.test(sp.get("fromNumber") ?? "") ? sp.get("fromNumber")! : undefined,
      cursor: sp.get("cursor") || undefined,
    };
    const from = sp.get("from");
    const to = sp.get("to");
    if (from) filters.dateFrom = new Date(from);
    if (to) filters.dateTo = new Date(to);

    const data = await listActivity(filters);
    return ok(data);
  });
}
