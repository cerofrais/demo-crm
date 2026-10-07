/**
 * GET /api/users/activity-monitor?day=YYYY-MM-DD — each staff member's
 * activity-log actions in 10-minute slots for one IST day (today by default).
 * Same audience as the Users page.
 */
import { NextRequest } from "next/server";
import { handle, ok, requireAnyPermission, ApiError } from "@/lib/api";
import { listUsers } from "@/lib/keycloak-admin";
import { logger } from "@/lib/logger";
import { getActivityMonitor, isDay, istToday } from "@/lib/user-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireAnyPermission(["users.manage", "users.view"]);
    const day = req.nextUrl.searchParams.get("day") ?? istToday();
    if (!isDay(day)) throw new ApiError("VALIDATION_ERROR", "day must be YYYY-MM-DD", 400);

    // The staff directory adds people with no activity that day. Best-effort:
    // if Keycloak is unreachable the monitor still shows everyone who acted.
    const staff = await listUsers()
      .then((users) =>
        users
          .filter((u) => u.enabled && u.appRole)
          .map((u) => ({ sub: u.id, name: u.fullName, role: u.appRole })),
      )
      .catch((err) => {
        logger.warn({ err }, "activity monitor: staff directory unavailable");
        return [];
      });

    return ok(await getActivityMonitor(day, staff));
  });
}
