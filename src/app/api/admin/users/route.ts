/**
 * GET  /api/admin/users — list all staff accounts (Keycloak-backed).
 * POST /api/admin/users — create a new staff account with a role.
 */
import { NextRequest } from "next/server";
import { handle, ok, requirePermission, requireAnyPermission } from "@/lib/api";
import { createStaffUserSchema } from "@/lib/validation";
import { listUsers, createUser } from "@/lib/keycloak-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    await requireAnyPermission(["users.manage", "users.view"]);
    const users = await listUsers();
    return ok(users);
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    await requirePermission("users.manage");
    const input = createStaffUserSchema.parse(await req.json());
    const result = await createUser(input);
    return ok(result, undefined, 201);
  });
}
