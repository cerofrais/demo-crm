import { NextRequest, NextResponse } from "next/server";
import { can, canAny, ROUTE_GUARDS, type AppRole } from "@/lib/rbac";
import { DEMO_SESSION_COOKIE, decodeSessionCookie } from "@/lib/demo/session";

/**
 * DEMO BRANCH: same route-gating behavior as main's withAuth-based
 * middleware, but reading the plain demo-session cookie instead of a
 * NextAuth JWT — no Keycloak, no edge JWT verification needed.
 */
export default function middleware(req: NextRequest) {
  const raw = req.cookies.get(DEMO_SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);

  if (!session) {
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  const roles = [session.role] as AppRole[];
  const path = req.nextUrl.pathname;
  const guard = ROUTE_GUARDS.find((g) => path.startsWith(g.prefix));
  const allowed = guard ? (Array.isArray(guard.perm) ? canAny(roles, guard.perm) : can(roles, guard.perm)) : true;
  if (guard && !allowed) {
    return NextResponse.redirect(new URL("/leads", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/leads/:path*",
    "/guests/:path*",
    "/health/:path*",
    "/packages/:path*",
    "/referrals/:path*",
    "/resources/:path*",
    "/reports/:path*",
    "/settings/:path*",
    "/ai-decisions/:path*",
    "/users/:path*",
    "/whatsapp-numbers/:path*",
    "/lead-assignment/:path*",
    "/message-templates/:path*",
  ],
};
