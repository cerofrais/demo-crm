/**
 * PATCH  /api/whatsapp/autoreplies/:id — edit fields, or flip enabled (the
 *        on/off toggle).
 * DELETE /api/whatsapp/autoreplies/:id — remove it.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission } from "@/lib/api";
import { updateAutoReply, deleteAutoReply } from "@/lib/whatsapp-autoreply";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  triggerWord: z.string().max(200).nullable().optional(),
  replyText: z.string().min(1).max(2000).optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    await requirePermission("whatsapp.manage");
    const input = patchSchema.parse(await req.json());
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
