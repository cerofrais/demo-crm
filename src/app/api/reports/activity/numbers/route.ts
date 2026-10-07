/**
 * GET /api/reports/activity/numbers — the WhatsApp lines the Activity Log can
 * be filtered by: every number that has ever sent from the CRM, current or
 * not (a disconnected line still has history worth filtering to). Same gate
 * as the log itself.
 */
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { getLineIndex } from "@/lib/whatsapp-lines";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "reports.allStaff")) {
      throw new ApiError("FORBIDDEN", "No access to the activity log", 403);
    }
    const { options } = await getLineIndex();
    return ok(options);
  });
}
