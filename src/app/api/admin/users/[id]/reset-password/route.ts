/**
 * POST /api/admin/users/:id/reset-password — issue a fresh temporary
 * password (the account must change it on next login).
 */
import { handle, ok, requirePermission } from "@/lib/api";
import { resetUserPassword } from "@/lib/keycloak-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    await requirePermission("users.manage");
    const temporaryPassword = await resetUserPassword(params.id);
    return ok({ temporaryPassword });
  });
}
