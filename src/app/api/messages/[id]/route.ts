/**
 * PATCH  /api/messages/:id — correct a message's CRM-side body record.
 * DELETE /api/messages/:id — soft-delete (flag as deleted, row stays).
 * Neither reaches WhatsApp's own servers — this only tags the CRM's local
 * copy of the conversation. messaging.send-gated, same as sending.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ body: z.string().min(1).max(4000) });

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requirePermission("messaging.send");
    const message = await prisma.message.findUnique({ where: { id: params.id } });
    if (!message) throw new ApiError("NOT_FOUND", "Message not found", 404);
    if (message.deletedAt) throw new ApiError("BAD_REQUEST", "Message was deleted", 400);

    const { body } = patchSchema.parse(await req.json());
    const oldBody = message.body;

    const updated = await prisma.message.update({
      where: { id: params.id },
      data: { body, editedAt: new Date(), editedBySub: ctx.sub },
    });

    await prisma.activity.create({
      data: {
        enquiryId: message.enquiryId,
        guestId: message.guestId,
        actorSub: ctx.sub,
        actorRole: ctx.roles[0] ?? "STAFF",
        actorName: ctx.name,
        actionType: "message_edited",
        metadata: { messageId: message.id, oldBody, newBody: body },
      },
    });

    return ok({ id: updated.id, body: updated.body, editedAt: updated.editedAt?.toISOString() ?? null });
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requirePermission("messaging.send");
    const message = await prisma.message.findUnique({ where: { id: params.id } });
    if (!message) throw new ApiError("NOT_FOUND", "Message not found", 404);
    if (message.deletedAt) throw new ApiError("BAD_REQUEST", "Already deleted", 400);

    const updated = await prisma.message.update({
      where: { id: params.id },
      data: { deletedAt: new Date(), deletedBySub: ctx.sub },
    });

    await prisma.activity.create({
      data: {
        enquiryId: message.enquiryId,
        guestId: message.guestId,
        actorSub: ctx.sub,
        actorRole: ctx.roles[0] ?? "STAFF",
        actorName: ctx.name,
        actionType: "message_deleted",
        metadata: { messageId: message.id },
      },
    });

    return ok({ id: updated.id, deletedAt: updated.deletedAt?.toISOString() ?? null });
  });
}
