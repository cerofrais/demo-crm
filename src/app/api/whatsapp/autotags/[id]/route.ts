/**
 * PATCH  /api/whatsapp/autotags/:id — edit, or flip the on/off toggle.
 * DELETE /api/whatsapp/autotags/:id — remove it.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { updateAutoTag, deleteAutoTag } from "@/lib/auto-tag";
import { slugifyTag } from "@/lib/lead-tags";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  trigger: z.string().min(1).max(300).optional(),
  tag: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    await requirePermission("whatsapp.manage");
    const input = patchSchema.parse(await req.json());
    if (input.tag !== undefined && !slugifyTag(input.tag)) {
      throw new ApiError("VALIDATION_ERROR", "That tag has no usable letters or numbers", 400);
    }
    return ok(await updateAutoTag(params.id, input));
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    await requirePermission("whatsapp.manage");
    await deleteAutoTag(params.id);
    return ok({ id: params.id });
  });
}
