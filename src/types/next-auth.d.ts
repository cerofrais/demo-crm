import type { AppRole } from "@/lib/rbac";
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    roles: AppRole[];
    // F4: `accessToken` intentionally removed — the raw Keycloak access token
    // must never reach the browser; it stays on the server-side JWT only.
    /**
     * Stable per-session version stamp (unix seconds), sourced from the JWT's
     * `sv` — NOT the mutable `iat`. Compared against the session-revocation
     * marker to force-logout sessions minted before an admin-side change. F32.
     */
    iat?: number;
    user: {
      sub: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    roles?: AppRole[];
    accessToken?: string;
    idToken?: string;
    /** F32: stable session version stamped once at sign-in (unix seconds). */
    sv?: number;
  }
}
