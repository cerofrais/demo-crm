import { NextRequest } from "next/server";
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { packageSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

// PATCH /api/packages/:id — update / toggle active (Manager/Admin)
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    await requirePermission("packages.manage");
    const input = packageSchema.partial().parse(await req.json());
    try {
      const pkg = await prisma.package.update({ where: { id: params.id }, data: input });
      return ok(pkg);
    } catch {
      throw new ApiError("NOT_FOUND", "Package not found", 404);
    }
  });
}
