/** PATCH / DELETE /api/sheet-check/sources/:id — rename, relabel, switch off, remove. */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { deleteSource, updateSource } from "@/lib/sheet-check";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  campaignLabel: z.string().trim().max(120).nullable().optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.manage")) throw new ApiError("FORBIDDEN", "Admin/Manager only", 403);
    await updateSource(params.id, schema.parse(await req.json()));
    return ok({ id: params.id });
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.manage")) throw new ApiError("FORBIDDEN", "Admin/Manager only", 403);
    await deleteSource(params.id);
    return ok({ id: params.id, deleted: true });
  });
}
