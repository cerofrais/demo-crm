import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-side cookie clear for the NextAuth session, then 302 to /login.
 *
 * We can't do this from a Server Component layout (RSC cookies are read-only),
 * so the (app)/layout revocation check redirects here first. Handles both the
 * dev cookie name and the __Secure- variant used over HTTPS. Also clears the
 * callback/csrf cookies to fully reset the NextAuth flow state.
 *
 * On /login the client sees ?reason=<reason> and auto-triggers signIn() so the
 * user gets a near-seamless redirect back into the app with fresh roles.
 */
const NEXT_AUTH_COOKIES = [
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
  "next-auth.callback-url",
  "__Secure-next-auth.callback-url",
  "next-auth.csrf-token",
  "__Host-next-auth.csrf-token",
];

export async function GET(req: NextRequest) {
  // F33 (CSRF): this endpoint clears the session cookie, so a cross-origin
  // <a>/<img>/form pointing here could log any authenticated user out. Gate on
  // the browser-set Sec-Fetch-Site metadata header, which cannot be forged from
  // page JS. Legitimate triggers are all top-level same-origin navigations
  // (window.location.href in providers.tsx/client.ts, or the (app)/layout
  // server redirect) → "same-origin"; a direct address-bar hit → "none". Reject
  // the cross-origin values ("cross-site", "same-site") that a CSRF vector uses.
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site" || fetchSite === "same-site") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const reason = req.nextUrl.searchParams.get("reason") ?? "revoked";
  const target = new URL(`/login?reason=${encodeURIComponent(reason)}`, req.nextUrl.origin);

  const res = NextResponse.redirect(target);
  const jar = cookies();
  for (const name of NEXT_AUTH_COOKIES) {
    if (jar.has(name)) {
      // Delete on the response so it lands in the client's Set-Cookie.
      res.cookies.set(name, "", { path: "/", maxAge: 0 });
    }
  }
  return res;
}
