import { NextRequest, NextResponse } from "next/server";
import { can, canAny, ROUTE_GUARDS, type AppRole } from "@/lib/rbac";
import { DEMO_SESSION_COOKIE, decodeSessionCookie } from "@/lib/demo/session";

/**
 * DEMO BRANCH: same route-gating behavior as main's withAuth-based
 * middleware, but reading the plain demo-session cookie instead of a
 * NextAuth JWT — no Keycloak, no edge JWT verification needed.
 */
/** 1x1-agnostic placeholder shown wherever the demo would otherwise 404 on a
 *  binary it has no bytes for. */
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320"><rect width="480" height="320" fill="#f1f5f9"/><text x="240" y="150" font-family="system-ui,sans-serif" font-size="16" fill="#64748b" text-anchor="middle">Demo file</text><text x="240" y="176" font-family="system-ui,sans-serif" font-size="13" fill="#94a3b8" text-anchor="middle">No document store in this build</text></svg>`;

/** A valid, silent 0.5s mono WAV, built rather than pasted as a blob so the
 *  source stays readable. Keeps the recording player functional instead of
 *  rendering a control that errors the moment it's pressed. */
function silentWav(): Uint8Array {
  const rate = 8000;
  const samples = rate / 2;
  const buf = new Uint8Array(44 + samples);
  const view = new DataView(buf.buffer);
  const ascii = (off: number, s: string) => [...s].forEach((c, i) => buf[off + i] = c.charCodeAt(0));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);          // 8-bit
  ascii(36, "data");
  view.setUint32(40, samples, true);
  buf.fill(128, 44);                    // 8-bit PCM silence is mid-scale
  return buf;
}

export default function middleware(req: NextRequest) {
  const path0 = req.nextUrl.pathname;

  // Binary endpoints reached by <img>/<a>/<audio> src rather than fetch(),
  // so the demo's fetch interceptor never sees them and they'd otherwise hit
  // the real (DB-backed) route handlers and 500.
  if (/^\/api\/calls\/[^/]+\/recording\/?$/.test(path0)) {
    return new NextResponse(silentWav().buffer as ArrayBuffer, {
      headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
    });
  }
  // Excludes the JSON sub-routes the fetch interceptor owns, so this only
  // ever stands in for an actual document id.
  if (/^\/api\/files\/(?!meta|confirm|upload-url|demo-put)[^/]+\/?$/.test(path0)) {
    return new NextResponse(PLACEHOLDER_SVG, {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" },
    });
  }

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
    // Binary stand-ins — see the handlers at the top of middleware().
    "/api/files/:path*",
    "/api/calls/:path*",
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
    "/sheet-check/:path*",
    "/message-templates/:path*",
  ],
};
