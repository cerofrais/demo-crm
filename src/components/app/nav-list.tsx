"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/lib/demo/session-client";
import {
  LayoutDashboard,
  Users,
  UserSearch,
  HeartPulse,
  Package,
  Ticket,
  FolderOpen,
  BarChart3,
  Settings,
  ListTodo,
  Phone,
  ShieldCheck,
  UserCog,
  MessageCircle,
  Shuffle,
  LayoutTemplate,
  History,
  Bot,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const NAV_ICONS: Record<string, LucideIcon> = {
  LayoutDashboard,
  Users,
  UserSearch,
  HeartPulse,
  Package,
  Ticket,
  FolderOpen,
  BarChart3,
  Settings,
  ListTodo,
  Phone,
  ShieldCheck,
  UserCog,
  MessageCircle,
  Shuffle,
  LayoutTemplate,
  History,
  Bot,
};

export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

/** Shared nav links, used by the desktop sidebar and the mobile drawer. */
export function NavList({
  nav,
  collapsed = false,
  onNavigate,
}: {
  nav: NavItem[];
  /** Icon-only (tablet rail). */
  collapsed?: boolean;
  /** Called after a link is tapped — used to close the mobile drawer. */
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    // min-h-0 + overflow-y-auto: the shell is h-[100dvh] overflow-hidden, so
    // without these a long nav (admin has 14 items) pushes the user footer and
    // sign-out off-screen on short viewports (e.g. a 1366x768 laptop) with no
    // way to reach them.
    <nav className="scrollbar-thin min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2">
      {nav.map((item) => {
        const Icon = NAV_ICONS[item.icon] ?? LayoutDashboard;
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            title={collapsed ? item.label : undefined}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
              // 44px min touch target
              "min-h-[44px] py-2",
              collapsed && "justify-center px-0",
              active
                ? "bg-sidebar-accent text-white"
                : "text-sidebar-foreground/80 hover:bg-white/5 hover:text-white",
            )}
          >
            <Icon className="h-[18px] w-[18px] shrink-0" />
            {!collapsed && item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SignOutButton({ collapsed = false }: { collapsed?: boolean }) {
  async function handleSignOut() {
    const loginUrl = `${window.location.origin}/login`;
    let url = loginUrl;
    try {
      const res = await fetch(
        `/api/auth/federated-logout?redirectTo=${encodeURIComponent(loginUrl)}`,
      );
      if (res.ok) url = (await res.json()).url ?? loginUrl;
    } catch {
      /* fall back to local-only sign out */
    }
    await signOut({ redirect: false });
    window.location.href = url;
  }

  return (
    <button
      title="Sign out"
      aria-label="Sign out"
      onClick={handleSignOut}
      className={cn(
        "flex h-11 w-11 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-white/10 hover:text-white",
        collapsed && "mx-auto",
      )}
    >
      <LogOut className="h-5 w-5" />
    </button>
  );
}

export function UserFooter({
  user,
  collapsed = false,
}: {
  user: { name: string; email?: string; role: string };
  collapsed?: boolean;
}) {
  const initials = user.name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 border-t border-white/10 p-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white">
          {initials}
        </div>
        <SignOutButton collapsed />
      </div>
    );
  }

  return (
    <div className="border-t border-white/10 p-3">
      <div className="flex items-center gap-3 rounded-lg px-2 py-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white">
          {initials}
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-medium text-white">{user.name}</div>
          <div className="truncate text-[11px] text-sidebar-foreground/60">{user.email}</div>
        </div>
        <SignOutButton />
      </div>
    </div>
  );
}
