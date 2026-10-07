/**
 * GET /api/guests/broadcast/status — progress for every broadcast currently
 * running, oldest first. Returns an array: broadcasts run side by side now,
 * so there is no single "the active one", and the Guests page shows each of
 * them rather than only the newest.
 */
import { handle, ok, requireAllPermissions } from "@/lib/api";
import { listActiveBroadcasts } from "@/lib/broadcast";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    await requireAllPermissions(["messaging.broadcast", "guests.view"]);
    const jobs = await listActiveBroadcasts();
    return ok(
      jobs.map((job) => ({
        id: job.id,
        status: job.status,
        templateName: job.templateName,
        totalCount: job.totalCount,
        sentCount: job.sentCount,
        failedCount: job.failedCount,
        cursor: job.cursor,
        createdAt: job.createdAt.toISOString(),
      })),
    );
  });
}
