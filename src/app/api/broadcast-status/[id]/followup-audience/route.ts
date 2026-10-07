/**
 * GET /api/broadcast-status/:id/followup-audience — how a campaign's engaged
 * guests break down right now: targeted → engaged → awaiting our reply.
 * Powers the follow-up dialog's live preview.
 *
 * ?trigger=Enquire Now  narrows "engaged" to guests who tapped that button.
 * ?quietHours=24        excludes anyone we've messaged more recently.
 *
 * Computed on demand rather than stored: "still waiting on them" changes
 * every time a guest replies, so a cached number would be stale on arrival.
 */
import { NextRequest } from "next/server";
import { handle, ok, requirePermission } from "@/lib/api";
import { resolveFollowUpAudience, DEFAULT_QUIET_HOURS } from "@/lib/broadcast-followup";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    await requirePermission("messaging.viewStatus");
    const sp = req.nextUrl.searchParams;
    const quietHours = Number(sp.get("quietHours") ?? DEFAULT_QUIET_HOURS);
    const a = await resolveFollowUpAudience(params.id, {
      trigger: sp.get("trigger") || null,
      quietHours: Number.isFinite(quietHours) ? quietHours : DEFAULT_QUIET_HOURS,
    });
    return ok({
      targeted: a.targeted,
      engaged: a.engaged,
      awaitingReply: a.awaitingReply,
      // What the follow-up would actually send to — awaiting, minus anyone
      // deleted/blocked/without a number since.
      recipients: a.guestIds.length,
    });
  });
}
