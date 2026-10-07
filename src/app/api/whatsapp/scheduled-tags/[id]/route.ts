/**
 * PATCH  /api/whatsapp/scheduled-tags/[id] — pause one, rename it, or move
 *   its window.
 * DELETE /api/whatsapp/scheduled-tags/[id] — remove it. Tags already applied
 *   stay on their leads: they record where those people actually came from.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handle, ok, requirePermission } from "@/lib/api";
import { deleteScheduledTag, updateScheduledTag } from "@/lib/scheduled-tag";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().max(120).nullable().optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    await requirePermission("whatsapp.manage");
    const input = patchSchema.parse(await req.json());
    if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
      throw new ApiError("VALIDATION_ERROR", "The window has to end after it starts.", 400);
    }
    return ok(await updateScheduledTag(params.id, input));
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    await requirePermission("whatsapp.manage");
    await deleteScheduledTag(params.id);
    return ok({ deleted: true });
  });
}
