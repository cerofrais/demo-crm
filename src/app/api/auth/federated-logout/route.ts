import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { env, keycloakIssuer, useSecureCookies } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Builds the Keycloak end-session URL so we can terminate the Keycloak SSO
 * session — not just the local NextAuth cookie. Called *before* signOut() so the
 * id_token is still available as id_token_hint (avoids a Keycloak confirm page).
 */
export async function GET(req: NextRequest) {
  // Same fix as middleware.ts: without an explicit secureCookie, getToken()
  // independently re-derives it from NEXTAUTH_URL's scheme instead of
  // asking authOptions — on an https NEXTAUTH_URL it looks for
  // "__Secure-next-auth.session-token" even when useSecureCookies (driven
  // by NODE_ENV/ALLOW_INSECURE_PROD_CONFIG, not the URL) made the actual
  // session cookie the plain, unprefixed name. It then reads back
  // token=null, idToken is undefined, and the id_token_hint fallback below
  // never fires — which is exactly what makes Keycloak show its logout
  // confirmation page instead of silently ending the SSO session.
  const token = await getToken({ req, secret: env.NEXTAUTH_SECRET, secureCookie: useSecureCookies });
  const idToken = token?.idToken as string | undefined;

  // Return to /login on the SAME host the user is actually browsing
  // (e.g. harsha-pc-ubuntu:3000, not APP_URL's localhost). The client passes
  // its origin; Keycloak still validates it against the realm's registered
  // post-logout redirect URIs.
  const requested = req.nextUrl.searchParams.get("redirectTo");
  const postLogout = requested ?? `${req.nextUrl.origin}/login`;

  const params = new URLSearchParams({ post_logout_redirect_uri: postLogout });
  if (idToken) params.set("id_token_hint", idToken);
  else params.set("client_id", env.KEYCLOAK_CLIENT_ID);

  const url = `${keycloakIssuer}/protocol/openid-connect/logout?${params.toString()}`;
  return NextResponse.json({ url });
}
