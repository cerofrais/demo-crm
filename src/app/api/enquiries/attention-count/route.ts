import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { countLeadsNeedingAttention, listLeadsNeedingAttention } from "@/lib/enquiries";

export const dynamic = "force-dynamic";

/**
 * GET /api/enquiries/attention-count — how many leads are waiting on THIS
 * user, for the notification badge.
 *
 * `?list=1` also returns the leads themselves, each with the inbound message
 * that flagged it. The badge polls on a timer and only needs the number, so
 * the list is fetched separately when the dropdown is actually opened —
 * otherwise every client would pull message bodies every 30 seconds to render
 * a digit.
 *
 * Both paths are scoped to exactly what the board would show this user, so
 * the badge can never point at a lead they can't open.
 */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view")) {
      throw new ApiError("FORBIDDEN", "No access to leads", 403);
    }
    if (req.nextUrl.searchParams.get("list") === "1") {
      const limit = Number(req.nextUrl.searchParams.get("limit") ?? 15);
      const { items, total } = await listLeadsNeedingAttention(
        ctx.roles,
        ctx.sub,
        Number.isFinite(limit) ? limit : 15,
      );
      return ok({ count: total, items });
    }
    return ok({ count: await countLeadsNeedingAttention(ctx.roles, ctx.sub) });
  });
}
