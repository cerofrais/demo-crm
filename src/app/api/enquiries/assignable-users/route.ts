/**
 * GET /api/enquiries/assignable-users — staff a lead can be reassigned to.
 * Same audience as `leads.manage` (Admin, Manager) — reads live from
 * Keycloak via the app's own service account, not the lazily-populated
 * StaffProfile table, so a newly created user shows up immediately.
 */
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { listUsers } from "@/lib/keycloak-admin";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const ctx = await requirePermission("leads.manage");
    // F23: per-user QPS ceiling so a single authenticated user can't spin this
    // endpoint (which drives listUsers' ~N+1 Keycloak role fetches) into a DoS.
    // Defence-in-depth alongside the 60s cache in listUsers(). failOpen (helper
    // default) so a Redis blip degrades to unmetered rather than locking admins out.
    const rl = await rateLimit({ key: `assignable-users:${ctx.sub}`, limit: 10, windowSec: 10 });
    if (!rl.allowed) {
      throw new ApiError("RATE_LIMITED", "Too many requests. Please slow down.", 429);
    }
    const users = await listUsers();
    const assignable = users
      .filter((u) => u.enabled)
      .map((u) => ({ id: u.id, name: u.fullName, role: u.appRole }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return ok(assignable);
  });
}
