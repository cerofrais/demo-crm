import { NextRequest } from "next/server";
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { addGuestTag, removeGuestTag } from "@/lib/tags-service";
import { tagMutationSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/guests/:id/tags — add or remove a custom tag on a guest.
 * Added tags are registered in the shared vocabulary so anyone can reuse them.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requirePermission("leads.manage");
    const { add, remove } = tagMutationSchema.parse(await req.json());

    const guest = await prisma.guest.findFirst({
      where: { id: params.id, deletedAt: null },
      select: { id: true },
    });
    if (!guest) throw new ApiError("NOT_FOUND", "Guest not found", 404);

    const tags = add
      ? await addGuestTag(params.id, add, ctx.sub)
      : await removeGuestTag(params.id, remove!);

    return ok({ id: params.id, tags });
  });
}
