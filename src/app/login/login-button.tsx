"use client";

import { useState } from "react";
import { LogIn, ShieldCheck, Stethoscope, Users, Headset, Briefcase, UserCog, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEMO_USERS } from "@/lib/demo/seed";
import { setClientSessionCookie } from "@/lib/demo/session";
import { DEMO_SESSION_EVENT } from "@/lib/demo/session-client";
import { ROLE_LABEL, type AppRole } from "@/lib/rbac";

const ROLE_ICON: Record<AppRole, typeof LogIn> = {
  ADMIN: ShieldCheck,
  MANAGER: Briefcase,
  DOCTOR: Stethoscope,
  DOCTORADMIN: Stethoscope,
  RECEPTION: Headset,
  SALES: Users,
  STAFF: UserCog,
  VIEWER: Eye,
};

const ROLE_BLURB: Record<AppRole, string> = {
  ADMIN: "Full access — analytics, user & role management, AI audit log.",
  MANAGER: "Pipeline oversight, packages, referrals, reports across all staff.",
  DOCTOR: "Doctor-consultation queue, health records, accept/reject decisions.",
  DOCTORADMIN: "Reads the whole board, works only the doctor's column; health records.",
  RECEPTION: "Own + unassigned leads, guest messaging, day-to-day front office.",
  SALES: "Own leads up to booking confirmation, messaging, reports.",
  STAFF: "Read/write on leads & guests, no admin settings.",
  VIEWER: "Read-only across the app — great for a walkthrough.",
};

export function LoginButton() {
  const [signingIn, setSigningIn] = useState<string | null>(null);

  function handleSignIn(user: (typeof DEMO_USERS)[number]) {
    setSigningIn(user.sub);
    setClientSessionCookie({ sub: user.sub, name: user.name, email: user.email, role: user.role });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(DEMO_SESSION_EVENT));
      window.location.href = "/";
    }
  }

  return (
    <div className="space-y-2">
      <p className="mb-3 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Pick a role to explore the demo
      </p>
      {DEMO_USERS.map((user) => {
        const Icon = ROLE_ICON[user.role];
        return (
          <button
            key={user.sub}
            onClick={() => handleSignIn(user)}
            disabled={signingIn !== null}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 text-left transition-colors hover:border-brand-400 hover:bg-brand-50 disabled:opacity-60",
              signingIn === user.sub && "border-brand-500 bg-brand-50",
            )}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700">
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{user.name}</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-secondary-foreground">
                  {ROLE_LABEL[user.role]}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {ROLE_BLURB[user.role]}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
