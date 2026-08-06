/**
 * Keycloak Admin REST API client — powers the in-app Users page so admins
 * can create/update/delete staff accounts without touching the Keycloak
 * console directly.
 *
 * Authenticates as the `tre-crm` client itself via the client_credentials
 * grant (not the master-realm superadmin), scoped to exactly the
 * `realm-management` roles needed to manage users in THIS realm:
 * manage-users, view-users, query-users. Requires the client's service
 * account to be enabled with those roles — see docs/16-user-management.md
 * for the one-time realm setup step (existing deployed realms need a manual
 * sync, same as the post-logout-redirect-uri fix).
 */
import { randomBytes } from "node:crypto";
import { env } from "./env";
import { logger } from "./logger";
import { prisma } from "./prisma";
import { redis } from "./redis";
import type { AppRole } from "./rbac";
import { CRM_ROLES, CRM_ROLE_TO_APP_ROLE, type CrmRole } from "./keycloak-roles";

export { CRM_ROLES, type CrmRole };

export interface KeycloakUserDTO {
  id: string;
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  phone: string | null;
  enabled: boolean;
  role: CrmRole | null;
  appRole: AppRole | null;
  createdAt: string | null;
  /**
   * F42: true when the per-user role lookup FAILED (transient Keycloak error),
   * as opposed to `role: null` meaning the user genuinely has no crm-* role.
   * Callers must not treat a fetch error as "unassigned" (that would let an
   * admin silently downgrade a real admin).
   */
  roleFetchError?: boolean;
}

/**
 * F43: thrown when a user's realm role mapping can't be fetched. Distinct from
 * "user has no role" so callers (e.g. the admin PATCH route) can treat the
 * before-state as UNKNOWN and skip revocation inference instead of acting on a
 * phantom role change.
 */
export class RoleFetchError extends Error {
  constructor(userId: string, options?: { cause?: unknown }) {
    super(`Failed to fetch Keycloak realm roles for user ${userId}`, options);
    this.name = "RoleFetchError";
  }
}

const ADMIN_BASE = `${env.KEYCLOAK_URL}/admin/realms/${env.KEYCLOAK_REALM}`;

// ---------------------------------------------------------------------------
// Token + fetch plumbing
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAdminToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5_000) {
    return cachedToken.token;
  }
  const res = await fetch(`${env.KEYCLOAK_URL}/realms/${env.KEYCLOAK_REALM}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.KEYCLOAK_CLIENT_ID,
      client_secret: env.KEYCLOAK_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Keycloak admin token request failed (${res.status}). Is the tre-crm client's service account enabled with realm-management roles? ${text.slice(0, 300)}`,
    );
  }
  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 60) * 1000,
  };
  return cachedToken.token;
}

async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAdminToken();
  return fetch(`${ADMIN_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

async function adminFetchOk(path: string, init?: RequestInit): Promise<Response> {
  const res = await adminFetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Keycloak admin API ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Realm role lookup (cached — the 5 crm-* roles are static config)
// ---------------------------------------------------------------------------

let roleCache: Map<CrmRole, { id: string; name: string }> | null = null;

async function getCrmRoleObjects(): Promise<Map<CrmRole, { id: string; name: string }>> {
  if (roleCache) return roleCache;
  const res = await adminFetchOk("/roles");
  const roles: Array<{ id: string; name: string }> = await res.json();
  const map = new Map<CrmRole, { id: string; name: string }>();
  for (const r of roles) {
    if ((CRM_ROLES as readonly string[]).includes(r.name)) {
      map.set(r.name as CrmRole, { id: r.id, name: r.name });
    }
  }
  roleCache = map;
  return map;
}

async function getUserCrmRole(userId: string): Promise<CrmRole | null> {
  const res = await adminFetchOk(`/users/${userId}/role-mappings/realm`);
  const roles: Array<{ name: string }> = await res.json();
  const match = roles.find((r) => (CRM_ROLES as readonly string[]).includes(r.name));
  return (match?.name as CrmRole | undefined) ?? null;
}

/** Replaces any existing crm-* realm role with exactly one new role. */
export async function setUserRole(userId: string, role: CrmRole): Promise<void> {
  const roleObjects = await getCrmRoleObjects();
  const target = roleObjects.get(role);
  if (!target) throw new Error(`Unknown role ${role} — not found in the realm`);

  const current = await adminFetchOk(`/users/${userId}/role-mappings/realm`);
  const existing: Array<{ id: string; name: string }> = await current.json();
  const toRemove = existing.filter((r) => (CRM_ROLES as readonly string[]).includes(r.name));

  if (toRemove.length) {
    await adminFetchOk(`/users/${userId}/role-mappings/realm`, {
      method: "DELETE",
      body: JSON.stringify(toRemove),
    });
  }
  await adminFetchOk(`/users/${userId}/role-mappings/realm`, {
    method: "POST",
    body: JSON.stringify([target]),
  });
}

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

interface RawKeycloakUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  createdTimestamp?: number;
}

function toDTO(
  u: RawKeycloakUser,
  role: CrmRole | null,
  phone: string | null = null,
  roleFetchError = false,
): KeycloakUserDTO {
  const fullName = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username;
  return {
    id: u.id,
    username: u.username,
    email: u.email ?? null,
    firstName: u.firstName ?? null,
    lastName: u.lastName ?? null,
    fullName,
    phone,
    enabled: u.enabled,
    role,
    appRole: role ? CRM_ROLE_TO_APP_ROLE[role] : null,
    createdAt: u.createdTimestamp ? new Date(u.createdTimestamp).toISOString() : null,
    roleFetchError,
  };
}

function fullNameOf(u: RawKeycloakUser): string {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username;
}

// ---------------------------------------------------------------------------
// Public CRUD
// ---------------------------------------------------------------------------

/**
 * F23: cache key + TTL for the full user+role listing. listUsers does ~1 + N
 * upstream calls (one role-mapping fetch per user), so an unauthenticated-facing
 * caller hitting it in a loop is a Keycloak DoS surface. A short cache bounds the
 * upstream load; it's invalidated by every admin user mutation below.
 */
const USER_LIST_CACHE_KEY = "keycloak:user-list:v1";
const USER_LIST_CACHE_TTL = 60; // seconds

/** F23: drop the cached user listing after any admin mutation. */
export async function invalidateUserListCache(): Promise<void> {
  try {
    await redis.del(USER_LIST_CACHE_KEY);
  } catch (err) {
    // Non-fatal: worst case the listing is stale until the 60s TTL lapses.
    logger.warn({ err }, "keycloak: user-list cache invalidation failed (non-fatal)");
  }
}

export async function listUsers(): Promise<KeycloakUserDTO[]> {
  // F23: serve from the short Redis cache when warm to avoid the per-user role
  // fetch storm on every request.
  try {
    const cached = await redis.get(USER_LIST_CACHE_KEY);
    if (cached) return JSON.parse(cached) as KeycloakUserDTO[];
  } catch (err) {
    logger.warn({ err }, "keycloak: user-list cache read failed — falling through to Keycloak");
  }

  const res = await adminFetchOk("/users?max=200");
  const users: RawKeycloakUser[] = await res.json();
  // service accounts show up as regular users — filter out ours.
  const staff = users.filter((u) => !u.username.startsWith("service-account-"));
  const profiles = await prisma.staffProfile.findMany({ select: { keycloakId: true, phone: true } });
  const phoneById = new Map(profiles.map((p) => [p.keycloakId, p.phone]));
  const dtos = await Promise.all(
    staff.map(async (u) => {
      // F42: distinguish a transient role-fetch failure (roleFetchError) from a
      // user who genuinely has no crm-* role (role: null) — the old
      // `.catch(() => null)` conflated the two, letting an admin unknowingly
      // downgrade a real admin whose role lookup happened to blip.
      let role: CrmRole | null = null;
      let roleFetchError = false;
      try {
        role = await getUserCrmRole(u.id);
      } catch (err) {
        roleFetchError = true;
        logger.warn({ err, userId: u.id }, "keycloak: role lookup failed in listUsers — marking roleFetchError");
      }
      // Opportunistic backfill: StaffProfile.role is denormalized from
      // Keycloak so the inbound-call webhook can filter by role without an
      // Admin API round trip mid-call. Keycloak has no role-change webhook,
      // so every Users-page load re-syncs it here instead — cheap (one
      // upsert per staff member) and covers profiles created before this
      // field existed. Skipped on a fetch error (role stays null above), so
      // a transient blip can't overwrite a good backfilled role with null.
      if (role) {
        await prisma.staffProfile.upsert({
          where: { keycloakId: u.id },
          create: { keycloakId: u.id, displayName: fullNameOf(u), role: CRM_ROLE_TO_APP_ROLE[role], isOnline: false },
          update: { role: CRM_ROLE_TO_APP_ROLE[role] },
        }).catch(() => null);
      }
      return toDTO(u, role, phoneById.get(u.id) ?? null, roleFetchError);
    }),
  );

  // Never cache a degraded snapshot — a role blip would otherwise pin wrong role
  // data for the whole TTL.
  if (!dtos.some((d) => d.roleFetchError)) {
    try {
      await redis.set(USER_LIST_CACHE_KEY, JSON.stringify(dtos), "EX", USER_LIST_CACHE_TTL);
    } catch (err) {
      logger.warn({ err }, "keycloak: user-list cache write failed (non-fatal)");
    }
  }
  return dtos;
}

export interface CreateUserInput {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  role: CrmRole;
  /** E.164/Indian phone — stored on StaffProfile, not a Keycloak field. */
  phone?: string;
}

export interface CreateUserResult {
  user: KeycloakUserDTO;
  temporaryPassword: string;
}

function generateTempPassword(): string {
  // 16 chars, URL-safe alphabet — strong enough, easy to read aloud/type once.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
  const bytes = randomBytes(16);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export async function createUser(input: CreateUserInput): Promise<CreateUserResult> {
  const temporaryPassword = generateTempPassword();
  const res = await adminFetch("/users", {
    method: "POST",
    body: JSON.stringify({
      username: input.username,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      enabled: true,
      emailVerified: true,
      credentials: [{ type: "password", value: temporaryPassword, temporary: true }],
    }),
  });
  if (res.status === 409) {
    throw new Error("A user with that username or email already exists.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to create user (${res.status}): ${text.slice(0, 300)}`);
  }
  const location = res.headers.get("Location");
  const id = location?.split("/").pop();
  if (!id) throw new Error("Keycloak did not return the new user's id");

  await setUserRole(id, input.role);

  const created = await adminFetchOk(`/users/${id}`);
  const raw: RawKeycloakUser = await created.json();
  const displayName = fullNameOf(raw);
  const appRole = CRM_ROLE_TO_APP_ROLE[input.role];

  // isOnline: true by default — there's no separate "activate" step, and an
  // admin-created account with no way to ever flip this on (no self-service
  // toggle existed) used to sit permanently ineligible for inbound call
  // routing. Defaulting available and letting the person opt out via
  // Settings (PUT /api/staff-profiles/me) matches how everyone actually
  // expects a new starter to behave.
  // Always upsert (not just when a phone is given) so role stays synced
  // even for accounts created without a phone number yet.
  const profile = await prisma.staffProfile.upsert({
    where: { keycloakId: id },
    create: { keycloakId: id, displayName, phone: input.phone ?? null, role: appRole, isOnline: true },
    update: { displayName, phone: input.phone ?? undefined, role: appRole },
  });

  await invalidateUserListCache(); // F23: new user must appear immediately.
  logger.info({ userId: id, username: input.username, role: input.role }, "keycloak: user created");
  return { user: toDTO(raw, input.role, profile.phone), temporaryPassword };
}

export interface UpdateUserInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  enabled?: boolean;
  role?: CrmRole;
  /** E.164/Indian phone — "" clears it. Stored on StaffProfile, not Keycloak. */
  phone?: string;
}

export async function updateUser(id: string, input: UpdateUserInput): Promise<KeycloakUserDTO> {
  const { role, phone, ...profile } = input;
  if (Object.keys(profile).length > 0) {
    await adminFetchOk(`/users/${id}`, { method: "PUT", body: JSON.stringify(profile) });
  }
  if (role) await setUserRole(id, role);

  const res = await adminFetchOk(`/users/${id}`);
  const raw: RawKeycloakUser = await res.json();
  const currentRole = role ?? (await getUserCrmRole(id));
  const displayName = fullNameOf(raw);
  const appRole = currentRole ? CRM_ROLE_TO_APP_ROLE[currentRole] : undefined;

  // Always upsert (not just when phone/role change) so displayName and role
  // stay synced on every edit, same reasoning as createUser above.
  //
  // Disabling a Keycloak account only blocked login — it never touched
  // StaffProfile.isOnline, so a deactivated user could still sit in the
  // inbound call-routing pool (pickAvailableRep() only checks isOnline/
  // phone/role, it doesn't cross-check whether the account is enabled).
  // Force isOnline: false in lockstep with disabling so deactivation
  // actually removes them from routing, not just from being able to log in.
  const profileRow = await prisma.staffProfile.upsert({
    where: { keycloakId: id },
    create: { keycloakId: id, displayName, phone: phone || null, role: appRole ?? null, isOnline: input.enabled !== false },
    update: {
      displayName,
      ...(phone !== undefined && { phone: phone || null }),
      ...(appRole !== undefined && { role: appRole }),
      ...(input.enabled === false && { isOnline: false }),
    },
  });

  await invalidateUserListCache(); // F23: reflect the change on next listing.
  // F25 (DPDP PII): log only which fields changed, never the values
  // (firstName/lastName/email/phone).
  logger.info({ userId: id, updatedFields: Object.keys(input) }, "keycloak: user updated");
  return toDTO(raw, currentRole, profileRow.phone);
}

export async function deleteUser(id: string): Promise<void> {
  await adminFetchOk(`/users/${id}`, { method: "DELETE" });
  // Otherwise this row is orphaned forever — inbound call routing and the
  // new-lead round-robin (assignNextRep) query StaffProfile directly and
  // have no way to know the Keycloak identity behind it is gone, so a
  // deleted staff member would keep silently soaking up calls/leads.
  await prisma.staffProfile.delete({ where: { keycloakId: id } }).catch(() => null);
  await invalidateUserListCache(); // F23: drop the deleted user from the listing.
  logger.info({ userId: id }, "keycloak: user deleted");
}

/**
 * Ends the user's Keycloak SSO session so a subsequent silent re-SSO from the
 * CRM can't just re-issue a token for a disabled/deleted user. Not needed for
 * plain role changes (there we *want* silent re-SSO to pick up new roles).
 */
export async function logoutUser(id: string): Promise<void> {
  const res = await adminFetch(`/users/${id}/logout`, { method: "POST" });
  if (!res.ok && res.status !== 404) {
    // 404 = user already gone (delete path calls this pre-delete then post-delete
    // in some flows). Non-404 non-2xx we log but do not throw — the admin action
    // itself already succeeded; SSO cleanup is best-effort.
    const text = await res.text().catch(() => "");
    logger.warn(
      { userId: id, status: res.status, text: text.slice(0, 300) },
      "keycloak: logout-user request failed (non-fatal)",
    );
    return;
  }
  logger.info({ userId: id }, "keycloak: user sso session ended");
}

/**
 * Fetches the current (role, enabled) so the admin PATCH route can decide
 * whether the change actually warrants force-logout — avoids kicking someone
 * out just because the admin re-selected the same role.
 */
export async function getUserState(
  id: string,
): Promise<{ role: CrmRole | null; enabled: boolean } | null> {
  const res = await adminFetch(`/users/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Keycloak GET /users/${id} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  const raw: RawKeycloakUser = await res.json();
  // F43: do NOT swallow a role-fetch failure to null. Previously a transient
  // error looked identical to "no role", so the admin PATCH route would compute
  // a phantom roleChanged and wrongly force-logout the user. Throw a
  // distinguishable RoleFetchError so the caller can treat the before-state as
  // UNKNOWN and skip revocation inference.
  let role: CrmRole | null = null;
  try {
    role = await getUserCrmRole(id);
  } catch (err) {
    throw new RoleFetchError(id, { cause: err });
  }
  return { role, enabled: raw.enabled };
}

export async function resetUserPassword(id: string): Promise<string> {
  const temporaryPassword = generateTempPassword();
  await adminFetchOk(`/users/${id}/reset-password`, {
    method: "PUT",
    body: JSON.stringify({ type: "password", value: temporaryPassword, temporary: true }),
  });
  logger.info({ userId: id }, "keycloak: password reset");
  return temporaryPassword;
}
