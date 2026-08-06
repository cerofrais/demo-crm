import type { AppRole } from "./types";

/** Environment-agnostic (no next/headers, no "use client") so it can be
 *  imported from both server (auth.ts) and client (session-client.tsx) code. */

export const DEMO_SESSION_COOKIE = "meridian_demo_session";

export interface DemoSessionData {
  sub: string;
  name: string;
  email: string;
  role: AppRole;
}

export function encodeSessionCookie(data: DemoSessionData): string {
  return encodeURIComponent(JSON.stringify(data));
}

export function decodeSessionCookie(raw: string | undefined | null): DemoSessionData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    if (parsed && typeof parsed.sub === "string" && typeof parsed.role === "string") {
      return parsed as DemoSessionData;
    }
    return null;
  } catch {
    return null;
  }
}

/** Client-side helpers — set/clear the demo session cookie from the browser. */
export function setClientSessionCookie(data: DemoSessionData) {
  const value = encodeSessionCookie(data);
  // 8h expiry, matches the old NextAuth session maxAge.
  const maxAge = 8 * 60 * 60;
  document.cookie = `${DEMO_SESSION_COOKIE}=${value}; path=/; max-age=${maxAge}; samesite=lax`;
}

export function clearClientSessionCookie() {
  document.cookie = `${DEMO_SESSION_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

export function readClientSessionCookie(): DemoSessionData | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${DEMO_SESSION_COOKIE}=([^;]*)`));
  return decodeSessionCookie(match?.[1]);
}
