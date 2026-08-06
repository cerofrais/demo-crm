import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { auth } from "./auth";
import { can, canAny, type AppRole, type Permission } from "./rbac";
import { logger } from "./logger";
import { isSessionRevoked } from "./session-revocation";

/**
 * Shared API conventions (tech spec §7.2):
 *   success -> { data, meta? }
 *   error   -> { error: { code, message, correlationId } }
 */

export function ok<T>(data: T, meta?: Record<string, unknown>, status = 200) {
  return NextResponse.json({ data, ...(meta ? { meta } : {}) }, { status });
}

export function fail(
  code: string,
  message: string,
  status = 400,
  correlationId = randomUUID(),
) {
  return NextResponse.json(
    { error: { code, message, correlationId } },
    { status },
  );
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Wrap a handler to map thrown errors to the standard error envelope. */
export function handle(
  fn: () => Promise<NextResponse>,
): Promise<NextResponse> {
  return fn().catch((err) => {
    const correlationId = randomUUID();
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, correlationId);
    }
    if (err instanceof ZodError) {
      return fail("VALIDATION_ERROR", err.issues.map((i) => i.message).join("; "), 400, correlationId);
    }
    logger.error({ err, correlationId }, "Unhandled API error");
    return fail("INTERNAL", "Something went wrong.", 500, correlationId);
  });
}

export interface AuthContext {
  sub: string;
  name: string;
  email?: string;
  roles: AppRole[];
}

/** Require an authenticated session; throws 401 otherwise. */
export async function requireSession(): Promise<AuthContext> {
  const session = await auth();
  if (!session?.user?.sub) {
    throw new ApiError("UNAUTHENTICATED", "Sign in required.", 401);
  }
  // Reject tokens that predate an admin role/enabled/delete action on this
  // user. Client fetch wrapper recognises REAUTH_REQUIRED and kicks the
  // user through /api/auth/force-signout → /login → silent re-SSO.
  const revoked = await isSessionRevoked(session.user.sub, session.iat);
  if (revoked) {
    throw new ApiError(
      "REAUTH_REQUIRED",
      `Your account was updated (${revoked}). Please sign in again.`,
      401,
    );
  }
  return {
    sub: session.user.sub,
    name: session.user.name ?? "Unknown",
    email: session.user.email ?? undefined,
    roles: session.roles ?? [],
  };
}

/** Require a specific permission; throws 403 otherwise. */
export async function requirePermission(perm: Permission): Promise<AuthContext> {
  const ctx = await requireSession();
  if (!can(ctx.roles, perm)) {
    throw new ApiError("FORBIDDEN", `Missing permission: ${perm}`, 403);
  }
  return ctx;
}

/**
 * Require every permission in the list (AND, not OR); throws 403 otherwise.
 * Used where a single permission is too broad on its own — e.g. WhatsApp
 * broadcast needs both messaging.send AND guests.view, since Sales holds
 * messaging.send (for per-lead chat) but not guests.view and shouldn't be
 * able to reach the Guests-only broadcast feature via a direct API call.
 */
export async function requireAllPermissions(perms: Permission[]): Promise<AuthContext> {
  const ctx = await requireSession();
  const missing = perms.filter((p) => !can(ctx.roles, p));
  if (missing.length > 0) {
    throw new ApiError("FORBIDDEN", `Missing permission: ${missing.join(", ")}`, 403);
  }
  return ctx;
}

/**
 * Require any ONE of the listed permissions (OR); throws 403 otherwise.
 * Used for read endpoints a manage permission AND its read-only "*.view"
 * counterpart should both unlock — e.g. GET /api/admin/users is fine for
 * either users.manage or users.view, while POST/PATCH/DELETE stay
 * users.manage-only via the plain requirePermission().
 */
export async function requireAnyPermission(perms: Permission[]): Promise<AuthContext> {
  const ctx = await requireSession();
  if (!canAny(ctx.roles, perms)) {
    throw new ApiError("FORBIDDEN", `Missing permission: one of ${perms.join(", ")}`, 403);
  }
  return ctx;
}
