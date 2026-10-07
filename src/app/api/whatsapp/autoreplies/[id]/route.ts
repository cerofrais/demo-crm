/**
 * PATCH  /api/whatsapp/autoreplies/:id — edit fields, or flip enabled (the
 *        on/off toggle).
 * DELETE /api/whatsapp/autoreplies/:id — remove it.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { updateAutoReply, deleteAutoReply } from "@/lib/whatsapp-autoreply";
import { findBroadcastableDocument } from "@/lib/attachment-access";

export const dynamic = "force-dynamic";

const scheduleMin = z.number().int().min(0).max(1439).nullable();

const patchSchema = z.object({
  triggerWord: z.string().max(200).nullable().optional(),
  replyText: z.string().min(1).max(2000).optional(),
  enabled: z.boolean().optional(),
  activeFromMin: scheduleMin.optional(),
  activeToMin: scheduleMin.optional(),
  /** null clears the attachment; omitted leaves it alone. */
  attachmentDocumentId: z.string().uuid().nullable().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    const ctx = await requirePermission("whatsapp.manage");
    const input = patchSchema.parse(await req.json());
    if (input.attachmentDocumentId) {
      const doc = await findBroadcastableDocument(input.attachmentDocumentId, ctx.roles);
      if (!doc) throw new ApiError("NOT_FOUND", "That file isn't available to attach", 404);
    }
    return ok(await updateAutoReply(params.id, input));
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    await requirePermission("whatsapp.manage");
    await deleteAutoReply(params.id);
    return ok({ id: params.id });
  });
}
