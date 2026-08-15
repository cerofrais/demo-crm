/**
 * GET /api/broadcast-status/:id — per-recipient breakdown of one broadcast
 * trigger (delivered/read/failed/pending, with the error text for failures).
 * DELETE /api/broadcast-status/:id — soft-delete the trigger from this page
 * only. Never touches the Message rows it sent — those stay exactly as they
 * are in the guest's own WhatsApp conversation thread.
 */
import { NextRequest } from "next/server";
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

interface BroadcastError {
  guestId: string;
  error: string;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    await requirePermission("messaging.broadcast");

    const job = await prisma.broadcastJob.findFirst({
      where: { id: params.id, deletedAt: null },
    });
    if (!job) throw new ApiError("NOT_FOUND", "Broadcast trigger not found", 404);

    const [guests, messages] = await Promise.all([
      prisma.guest.findMany({
        where: { id: { in: job.guestIds } },
        select: { id: true, fullName: true, phone: true },
      }),
      prisma.message.findMany({
        where: { broadcastJobId: job.id },
        select: { guestId: true, status: true, errorDetail: true, createdAt: true },
      }),
    ]);
    const guestById = new Map(guests.map((g) => [g.id, g]));
    const messageByGuestId = new Map(messages.filter((m) => m.guestId).map((m) => [m.guestId as string, m]));
    const earlyErrorByGuestId = new Map(
      (job.errors as unknown as BroadcastError[]).map((e) => [e.guestId, e.error]),
    );

    const recipients = job.guestIds.map((guestId, index) => {
      const guest = guestById.get(guestId);
      const message = messageByGuestId.get(guestId);
      const processed = index < job.cursor;

      let status: "pending" | "sent" | "delivered" | "read" | "failed";
      let errorDetail: string | null = null;
      if (!processed) {
        status = "pending";
      } else if (message) {
        status = message.status as "sent" | "delivered" | "read" | "failed";
        errorDetail = message.errorDetail;
      } else if (earlyErrorByGuestId.has(guestId)) {
        status = "failed";
        errorDetail = earlyErrorByGuestId.get(guestId) ?? "Unknown error";
      } else {
        // Processed (index < cursor) but no Message row and no recorded
        // error — shouldn't normally happen, but don't silently drop the
        // recipient from the list.
        status = "failed";
        errorDetail = "No record of this send";
      }

      return {
        guestId,
        guestName: guest?.fullName ?? "Unknown guest",
        guestPhone: guest?.phone ?? null,
        status,
        errorDetail,
        sentAt: message?.createdAt.toISOString() ?? null,
      };
    });

    return ok({
      id: job.id,
      status: job.status,
      recipients,
    });
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    await requirePermission("leads.manage");

    const job = await prisma.broadcastJob.findFirst({
      where: { id: params.id, deletedAt: null },
    });
    if (!job) throw new ApiError("NOT_FOUND", "Broadcast trigger not found", 404);
    if (job.status === "queued" || job.status === "running") {
      throw new ApiError(
        "BAD_REQUEST",
        "This trigger is still active — cancel it first from the Guests page before deleting it.",
        400,
      );
    }

    await prisma.broadcastJob.update({
      where: { id: job.id },
      data: { deletedAt: new Date() },
    });

    return ok({ id: job.id, deleted: true });
  });
}
