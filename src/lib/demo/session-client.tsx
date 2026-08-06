"use client";

/**
 * Drop-in shim for the subset of `next-auth/react` this app actually uses
 * (SessionProvider, useSession, signIn, signOut) — backed by the demo
 * session cookie instead of a real NextAuth session. Import-compatible so
 * the 4 consuming files only needed their import source changed, not their
 * call sites.
 */
import { createContext, useContext, useEffect, useState } from "react";
import type { AppRole } from "./types";
import {
  readClientSessionCookie,
  clearClientSessionCookie,
  DEMO_SESSION_COOKIE,
} from "./session";

export const DEMO_SESSION_EVENT = "demo-session-changed";

type Status = "loading" | "authenticated" | "unauthenticated";

interface SessionShape {
  user: { sub: string; name: string; email: string };
  roles: AppRole[];
}

interface SessionContextValue {
  data: SessionShape | null;
  status: Status;
}

const SessionContext = createContext<SessionContextValue>({ data: null, status: "loading" });

function readSession(): SessionContextValue {
  const raw = readClientSessionCookie();
  if (!raw) return { data: null, status: "unauthenticated" };
  return {
    data: { user: { sub: raw.sub, name: raw.name, email: raw.email }, roles: [raw.role] },
    status: "authenticated",
  };
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SessionContextValue>({ data: null, status: "loading" });

  useEffect(() => {
    const refresh = () => setState(readSession());
    refresh();
    window.addEventListener(DEMO_SESSION_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(DEMO_SESSION_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  return useContext(SessionContext);
}

/** Real "sign in" happens via the role picker in login/login-button.tsx,
 *  which writes the cookie directly — this generic entrypoint just navigates. */
export async function signIn(_provider?: string, opts?: { callbackUrl?: string }) {
  if (typeof window !== "undefined") window.location.href = opts?.callbackUrl ?? "/";
}

export async function signOut(opts?: { redirect?: boolean; callbackUrl?: string }) {
  clearClientSessionCookie();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(DEMO_SESSION_EVENT));
    if (opts?.redirect !== false) window.location.href = opts?.callbackUrl ?? "/login";
  }
}

export { DEMO_SESSION_COOKIE };
