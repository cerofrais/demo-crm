/**
 * PATCH  /api/admin/email-autotags/:id — edit, or flip the on/off toggle.
 * DELETE /api/admin/email-autotags/:id — remove it.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAnyPermission, ApiError } from "@/lib/api";
import { updateEmailAutoTag, deleteEmailAutoTag } from "@/lib/email-auto-tag";
import { slugifyTag } from "@/lib/lead-tags";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  subjectTerms: z.array(z.string().max(200)).max(20).optional(),
  bodyTerms: z.array(z.string().max(500)).max(20).optional(),
  termMatch: z.enum(["any", "all"]).optional(),
  tag: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    await requireAnyPermission(["leads.manage", "whatsapp.manage"]);
    const input = patchSchema.parse(await req.json());
    if (input.tag !== undefined && !slugifyTag(input.tag)) {
      throw new ApiError("VALIDATION_ERROR", "That tag has no usable letters or numbers", 400);
    }
    return ok(await updateEmailAutoTag(params.id, input));
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    await requireAnyPermission(["leads.manage", "whatsapp.manage"]);
    await deleteEmailAutoTag(params.id);
    return ok({ id: params.id, deleted: true });
  });
}
