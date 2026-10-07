/**
 * GET /api/sheet-check — everything the Lead Sheet Check page shows:
 * settings, sheets, recent runs, and whether Google access and the cron
 * container are set up.
 */
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { canAny } from "@/lib/rbac";
import { getSettings, listRuns, listSources, nextDueAt } from "@/lib/sheet-check";
import { serviceAccountEmail } from "@/lib/google-sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();
    if (!canAny(ctx.roles, ["leads.manage", "lead-assignment.view"])) throw new ApiError("FORBIDDEN", "No access", 403);
    const [settings, sources, runs, due] = await Promise.all([getSettings(), listSources(), listRuns(), nextDueAt()]);
    return ok({
      settings,
      sources,
      runs,
      nextDueAt: due,
      serviceAccountEmail: serviceAccountEmail(),
      cronSecretConfigured: !!process.env.SHEET_CHECK_CRON_SECRET,
    });
  });
}
