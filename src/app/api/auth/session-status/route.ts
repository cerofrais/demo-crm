import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isSessionRevoked } from "@/lib/session-revocation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/session-status → { revoked: boolean, reason?: string }
 *
 * Polled by the client (on window focus + every 2 min) so that an idle user
 * whose role/enabled state was changed gets logged out without needing to
 * make another API call. Deliberately does NOT go through requireSession() —
 * that would itself throw REAUTH_REQUIRED on the very sessions this endpoint
 * exists to detect, causing an infinite kick loop.
 *
 * An unauthenticated caller gets { revoked: false } (nothing to revoke).
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.sub) {
    return NextResponse.json({ revoked: false });
  }
  const reason = await isSessionRevoked(session.user.sub, session.iat);
  return NextResponse.json(
    reason ? { revoked: true, reason } : { revoked: false },
    // Never let a proxy/browser cache this — we want fresh checks.
    { headers: { "Cache-Control": "no-store" } },
  );
}
