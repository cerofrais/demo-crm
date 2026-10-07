/**
 * GET /api/calls — paginated call list (admin/manager: all; others: own calls only)
 * Query params: direction, status, cursor (ISO startedAt), guestId, enquiryId,
 * tags (comma-separated lead tags) + tagMatch (any|all)
 */
import { NextRequest, NextResponse } from "next/server";
import { handle, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { listCalls, getCallsForGuest, getCallsForEnquiry } from "@/lib/calls";
import type { CallDirection, CallStatus } from "@prisma/client";
import { parseTagMatch } from "@/lib/tag-match";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return handle(async () => {
    // requireSession (not raw auth) so a revoked/disabled user is rejected here too.
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view")) {
      throw new ApiError("FORBIDDEN", "Missing permission: leads.view", 403);
    }

    const sp = req.nextUrl.searchParams;
    const guestId = sp.get("guestId");
    const enquiryId = sp.get("enquiryId");

    // F12: the same own-only scoping the full-list branch applies must also apply
    // to the guest/enquiry branches, or RECEPTION can enumerate anyone's calls.
    const keycloakId = ctx.sub;
    const canSeeAll = can(ctx.roles, "reports.allStaff");

    if (guestId) {
      return NextResponse.json(
        await getCallsForGuest(guestId, canSeeAll ? undefined : keycloakId),
      );
    }
    if (enquiryId) {
      return NextResponse.json(
        await getCallsForEnquiry(enquiryId, canSeeAll ? undefined : keycloakId),
      );
    }

    const unattended = sp.get("unattended") === "true";

    // Full list — only ADMIN/MANAGER see all; others see own. The unattended
    // (missed, no matching lead) tab is guestId-scoped, not rep-scoped — any
    // rep with calls.allStaff-gated page access should see the same shared
    // queue of unclaimed callers, so it skips the own-calls restriction.
    const items = await listCalls({
      direction: sp.get("direction") as CallDirection | null ?? undefined,
      status: sp.get("status") as CallStatus | null ?? undefined,
      repKeycloakId: unattended ? undefined : canSeeAll ? (sp.get("repId") ?? undefined) : keycloakId,
      dateFrom: sp.get("from") ? new Date(sp.get("from")!) : undefined,
      dateTo: sp.get("to") ? new Date(sp.get("to")!) : undefined,
      cursor: sp.get("cursor") ?? undefined,
      unattendedOnly: unattended,
      tags: sp.get("tags")?.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 30),
      tagMatch: parseTagMatch(sp.get("tagMatch"), "any"),
    });

    return NextResponse.json(items);
  });
}
