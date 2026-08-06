import { NextRequest } from "next/server";
import { handle, ok, requireSession, requirePermission } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { packageSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

// GET /api/packages — list (any authenticated user who can see leads/packages)
export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();
    const onlyActive = !can(ctx.roles, "packages.manage");
    const packages = await prisma.package.findMany({
      where: onlyActive ? { isActive: true } : {},
      orderBy: [{ isActive: "desc" }, { category: "asc" }, { basePriceINR: "asc" }],
    });
    return ok(packages);
  });
}

// POST /api/packages — create (Manager/Admin)
export async function POST(req: NextRequest) {
  return handle(async () => {
    await requirePermission("packages.manage");
    const input = packageSchema.parse(await req.json());
    const pkg = await prisma.package.create({ data: input });
    return ok(pkg, undefined, 201);
  });
}
