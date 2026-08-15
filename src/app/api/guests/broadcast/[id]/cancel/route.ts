/** POST /api/guests/broadcast/:id/cancel — stop a running/queued broadcast. */
import { handle, ok, requireAllPermissions } from "@/lib/api";
import { cancelBroadcast } from "@/lib/broadcast";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    await requireAllPermissions(["messaging.broadcast", "guests.view"]);
    await cancelBroadcast(params.id);
    return ok({ id: params.id, cancelled: true });
  });
}
