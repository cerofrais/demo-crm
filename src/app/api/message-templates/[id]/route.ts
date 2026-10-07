/**
 * PATCH  /api/message-templates/:id — edit, archive ({ archived: true }) or
 *        restore ({ archived: false }) a template. Admin/Manager only.
 * DELETE /api/message-templates/:id — remove a template. Admin/Manager only.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission } from "@/lib/api";
import { updateMessageTemplate, deleteMessageTemplate } from "@/lib/message-templates-service";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  subject: z.string().max(300).nullable().optional(),
  body: z.string().min(1).max(10_000).optional(),
  folderId: z.string().uuid().nullish(),
  archived: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    const ctx = await requirePermission("leads.manage");
    const input = patchSchema.parse(await req.json());
    return ok(await updateMessageTemplate(params.id, input, ctx.sub));
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    await requirePermission("leads.manage");
    await deleteMessageTemplate(params.id);
    return ok({ id: params.id });
  });
}
