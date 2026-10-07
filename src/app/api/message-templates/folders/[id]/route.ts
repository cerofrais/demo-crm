/**
 * PATCH  /api/message-templates/folders/[id] — rename it, or move it.
 * DELETE /api/message-templates/folders/[id] — remove it, keeping what is in
 *   it: templates and sub-folders move up to its parent, or to "Others".
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handle, ok, requirePermission } from "@/lib/api";
import { deleteFolder, FolderError, renameOrMoveFolder } from "@/lib/template-folders-service";
import { FOLDER_NAME_MAX } from "@/lib/template-folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(FOLDER_NAME_MAX).optional(),
  /** null moves the folder to the top level; omitted leaves it where it is. */
  parentId: z.string().uuid().nullable().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    await requirePermission("leads.manage");
    const input = patchSchema.parse(await req.json());
    try {
      return ok(await renameOrMoveFolder(params.id, input));
    } catch (err) {
      if (err instanceof FolderError) throw new ApiError("VALIDATION_ERROR", err.message, 400);
      throw err;
    }
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    await requirePermission("leads.manage");
    try {
      return ok(await deleteFolder(params.id));
    } catch (err) {
      if (err instanceof FolderError) throw new ApiError("VALIDATION_ERROR", err.message, 400);
      throw err;
    }
  });
}
