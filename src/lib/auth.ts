import { cookies } from "next/headers";
import { DEMO_SESSION_COOKIE, decodeSessionCookie } from "./demo/session";
import type { AppRole } from "./rbac";

/**
 * DEMO BRANCH: no Keycloak/NextAuth — "sign in" just picks a role from
 * src/app/login/login-button.tsx, which writes a plain (non-httpOnly) cookie
 * so both the browser and Server Components can read it. Keeps the same
 * `auth()` call signature the rest of the app already uses (session.user.sub,
 * session.roles, ...) so almost nothing outside this file needed to change.
 */
export interface DemoAuthSession {
  user: {
    sub: string;
    name?: string | null;
    email?: string | null;
  };
  roles: AppRole[];
  iat?: number;
}

export function auth(): DemoAuthSession | null {
  const jar = cookies();
  const data = decodeSessionCookie(jar.get(DEMO_SESSION_COOKIE)?.value);
  if (!data) return null;
  return {
    user: { sub: data.sub, name: data.name, email: data.email },
    roles: [data.role],
    iat: Math.floor(Date.now() / 1000),
  };
}
