import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { setGuestBlocked } from "@/lib/tags-service";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ blocked: z.boolean() });

/**
 * PATCH /api/guests/:id/block — block or unblock a guest. Once blocked,
 * every future inbound WhatsApp message or email from their phone/address
 * is silently dropped before it's ever stored — see the webhook and
 * inbound-mail handlers. Fully reversible; doesn't touch existing history.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requirePermission("leads.manage");
    const { blocked } = patchSchema.parse(await req.json());

    const guest = await prisma.guest.findFirst({
      where: { id: params.id, deletedAt: null },
      select: { fullName: true },
    });
    if (!guest) throw new ApiError("NOT_FOUND", "Guest not found", 404);

    const updated = await setGuestBlocked(params.id, blocked, ctx.sub);
    if (!updated) throw new ApiError("NOT_FOUND", "Guest not found", 404);

    await prisma.activity.create({
      data: {
        guestId: params.id,
        actorSub: ctx.sub,
        actorRole: ctx.roles[0] ?? "STAFF",
        actorName: ctx.name,
        actionType: blocked ? "guest_blocked" : "guest_unblocked",
        metadata: { guestName: guest.fullName },
      },
    });

    return ok({ id: params.id, isBlocked: updated.isBlocked, tags: updated.tags });
  });
}
