/**
 * PATCH  /api/admin/users/:id — update profile, role, or enabled state.
 * DELETE /api/admin/users/:id — permanently remove the Keycloak account.
 *
 * Any change that affects authorization (role, enabled, deletion) also stamps
 * a Redis force-logout marker so the target user's still-live NextAuth JWT
 * (which caches roles at sign-in time) is invalidated on their next request.
 * See src/lib/session-revocation.ts.
 */
import { NextRequest } from "next/server";
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { updateStaffUserSchema } from "@/lib/validation";
import {
  updateUser,
  deleteUser,
  logoutUser,
  getUserState,
  RoleFetchError,
} from "@/lib/keycloak-admin";
import { markRevoked } from "@/lib/session-revocation";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requirePermission("users.manage");
    if (params.id === ctx.sub) {
      throw new ApiError("FORBIDDEN", "You cannot change your own role or disable your own account here — use the Keycloak account console.", 403);
    }
    const input = updateStaffUserSchema.parse(await req.json());

    // Snapshot BEFORE the update so we can decide whether to force-logout.
    // Missing user → let updateUser produce the natural 404 for consistency.
    // A transient Keycloak role-fetch failure now throws RoleFetchError (F43) —
    // treat that as an UNKNOWN before-state so we never infer a phantom role
    // change, but still honor an explicit disable below.
    let before: Awaited<ReturnType<typeof getUserState>> = null;
    let beforeUnknown = false;
    try {
      before = await getUserState(params.id);
    } catch (err) {
      if (err instanceof RoleFetchError) {
        beforeUnknown = true;
      } else {
        throw err;
      }
    }

    const updated = await updateUser(params.id, input);

    // markRevoked now fails closed (throws on Redis outage). The KC update has
    // already succeeded, so surface a distinct 503 asking the admin to retry
    // rather than silently leaving the old session live.
    try {
      const beingDisabled = input.enabled === false && (before?.enabled ?? true);
      if (beingDisabled) {
        // Kill the KC SSO session too so silent re-SSO can't just re-issue a
        // token for a now-disabled user.
        await Promise.all([
          markRevoked(params.id, "disabled"),
          logoutUser(params.id),
        ]);
      } else if (!beforeUnknown && before) {
        const roleChanged = input.role !== undefined && input.role !== before.role;
        const beingEnabled = input.enabled === true && !before.enabled;
        if (roleChanged || beingEnabled) {
          // For a plain role change we DON'T end the KC session — the user's
          // next silent re-SSO will mint a fresh access_token with the updated
          // realm_access.roles, which is exactly what we want.
          await markRevoked(params.id, "role_changed");
        }
      }
    } catch (err) {
      logger.error({ err, userId: params.id }, "user updated but revocation marker write failed");
      throw new ApiError(
        "REVOCATION_FAILED",
        "User updated, but the session-revocation marker could not be written (Redis unavailable). Retry to force the user's re-login.",
        503,
      );
    }

    return ok(updated);
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requirePermission("users.manage");
    if (params.id === ctx.sub) {
      throw new ApiError("FORBIDDEN", "You cannot delete your own account.", 403);
    }
    // Order: revoke first (so any in-flight CRM request sees it) then kill
    // KC SSO, then delete. logoutUser tolerates 404 in case delete somehow
    // races ahead. markRevoked now throws on a Redis outage — but for a DELETE,
    // removing the account is more important than the marker, so don't let a
    // Redis blip block the deletion; log the (bounded, <=8h) JWT gap instead.
    let markerWritten = true;
    try {
      await markRevoked(params.id, "deleted");
    } catch (err) {
      markerWritten = false;
      logger.warn({ err, userId: params.id }, "delete: revocation marker write failed — proceeding with account removal");
    }
    await logoutUser(params.id);
    await deleteUser(params.id);
    return ok({ id: params.id, revocationMarkerWritten: markerWritten });
  });
}
