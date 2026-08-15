/**
 * GET /api/permissions — the one-place view of who can do what.
 *
 * Returns three things: the documented permission catalogue, the role →
 * permission matrix, and every staff account with the permissions their role
 * actually grants them. Read-only — changing a user's access is a role change,
 * which goes through the existing PATCH /api/admin/users/:id (it already
 * carries the self-lockout guard and session-revocation stamping).
 */
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { ALL_ROLES, can, permissionsFor, type AppRole } from "@/lib/rbac";
import { PERMISSION_CATALOG, PERMISSION_GROUP_ORDER } from "@/lib/permissions-catalog";
import { listUsers } from "@/lib/keycloak-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "users.manage")) {
      throw new ApiError("FORBIDDEN", "Admin only", 403);
    }

    const users = await listUsers();

    return ok({
      catalog: PERMISSION_CATALOG,
      groupOrder: PERMISSION_GROUP_ORDER,
      roles: ALL_ROLES,
      // role -> permission keys, so the client can render the matrix without
      // duplicating the table that rbac.ts owns.
      matrix: Object.fromEntries(ALL_ROLES.map((r) => [r, permissionsFor(r)])),
      users: users.map((u) => ({
        id: u.id,
        fullName: u.fullName,
        username: u.username,
        email: u.email,
        enabled: u.enabled,
        role: u.role,
        appRole: u.appRole,
        // F42: the role lookup FAILED, which is not the same as "no role".
        // Surfaced so the page can say "couldn't read" instead of rendering an
        // empty permission list that reads as though the user has no access.
        roleFetchError: u.roleFetchError ?? false,
        // Empty for a user genuinely without a crm-* role — they can sign in
        // but reach nothing, which is worth showing rather than hiding.
        permissions: u.appRole && !u.roleFetchError ? permissionsFor(u.appRole as AppRole) : [],
      })),
    });
  });
}
