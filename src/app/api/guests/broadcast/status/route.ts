/**
 * GET /api/guests/broadcast/status — poll for the active broadcast's
 * progress, or null if none is running. Lets the Guests page show a live
 * progress indicator and block starting a second broadcast client-side too.
 */
import { handle, ok, requireAllPermissions } from "@/lib/api";
import { getActiveBroadcast } from "@/lib/broadcast";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    await requireAllPermissions(["messaging.send", "guests.view"]);
    const job = await getActiveBroadcast();
    if (!job) return ok(null);
    return ok({
      id: job.id,
      status: job.status,
      totalCount: job.totalCount,
      sentCount: job.sentCount,
      failedCount: job.failedCount,
      cursor: job.cursor,
      createdAt: job.createdAt.toISOString(),
    });
  });
}
