"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Menu,
  MoreHorizontal,
  LayoutDashboard,
  X,
  PanelLeftOpen,
  PanelLeftClose,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet } from "@/components/ui/sheet";
import { NavList, UserFooter, NAV_ICONS, isActive, type NavItem } from "./nav-list";
import { SiteFooter } from "./site-footer";

/**
 * Responsive app shell.
 *   phone           (<md): top bar + hamburger drawer (with close button) + in-flow bottom nav
 *   tablet + desktop (md+): one expandable icon rail (icons-only <-> 240px
 *                     with labels), same toggle at every width from here up.
 *
 * 100dvh flex layout so the mobile URL bar doesn't clip content and the in-flow
 * bottom nav never overlaps the scroll area.
 */
export function AppShell({
  nav,
  user,
  children,
}: {
  nav: NavItem[];
  user: { name: string; email?: string; role: string };
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  // Default expanded (desktop's original always-full look); collapsed to an
  // icon rail only if we're starting out at tablet width, matching what
  // tablet already defaulted to before desktop got this same toggle. Once
  // toggled, the one state now drives both widths for the rest of the
  // session.
  const [railExpanded, setRailExpanded] = React.useState(true);
  const pathname = usePathname();

  React.useEffect(() => {
    if (window.innerWidth < 1024) setRailExpanded(false);
  }, []);

  // Close the phone drawer once the viewport grows past the phone breakpoint —
  // otherwise rotating (or resizing a window) leaves a full-screen dimmed nav
  // overlay sitting on top of a layout that already shows the sidebar.
  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setDrawerOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Bottom nav shows up to 5 destinations; if there are more, keep 4 + "More".
  const hasMore = nav.length > 5;
  const primary = hasMore ? nav.slice(0, 4) : nav.slice(0, 5);

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-muted/40">
      {/* Tablet + desktop: expandable icon rail, same toggle at every width */}
      <aside
        className={cn(
          // min-h-0 lets the inner NavList actually scroll instead of overflowing
          // the fixed-height shell (see nav-list.tsx).
          "no-print hidden min-h-0 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex",
          railExpanded ? "w-60" : "w-16",
        )}
      >
        {railExpanded ? <Brand role={user.role} /> : <BrandMark />}
        <NavList nav={nav} collapsed={!railExpanded} />
        <button
          onClick={() => setRailExpanded((v) => !v)}
          aria-label={railExpanded ? "Collapse sidebar" : "Expand sidebar"}
          title={railExpanded ? "Collapse" : "Expand"}
          className={cn(
            "mx-3 mb-1 flex min-h-[44px] items-center gap-3 rounded-lg px-3 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-white/5 hover:text-white",
            !railExpanded && "justify-center px-0",
          )}
        >
          {railExpanded ? (
            <>
              <PanelLeftClose className="h-[18px] w-[18px] shrink-0" />
              Collapse
            </>
          ) : (
            <PanelLeftOpen className="h-[18px] w-[18px] shrink-0" />
          )}
        </button>
        <UserFooter user={user} collapsed={!railExpanded} />
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Phone: top bar */}
        <header className="no-print flex shrink-0 items-center gap-3 border-b border-border bg-background px-4 pt-safe md:hidden">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            className="-ml-2 flex h-11 w-11 items-center justify-center rounded-md text-foreground hover:bg-secondary"
          >
            <Menu className="h-6 w-6" />
          </button>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-700 text-sm font-semibold text-white">
              M
            </div>
            <span className="text-sm font-semibold">Meridian Wellness</span>
          </div>
        </header>

        {/* data-scroll-container: this (not <body>) is the app's scroll element,
            so overlays lock scrolling here — see useOverlayBehavior in ui/sheet.tsx. */}
        <main data-scroll-container className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>

        {/* Attribution — a shrink-0 sibling of the scroll area, so it's pinned
            under every page without ever overlapping content. */}
        <SiteFooter />

        {/* Phone: bottom nav (in-flow, never overlaps the scroll area) */}
        <nav className="no-print flex shrink-0 items-stretch border-t border-border bg-background pb-safe md:hidden">
          {primary.map((item) => {
            const Icon = NAV_ICONS[item.icon] ?? LayoutDashboard;
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] font-medium",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <Icon className="h-5 w-5" />
                <span className="max-w-full truncate px-1">{item.label}</span>
              </Link>
            );
          })}
          {hasMore && (
            <button
              onClick={() => setDrawerOpen(true)}
              className="flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] font-medium text-muted-foreground"
              aria-label="More menu items"
            >
              <MoreHorizontal className="h-5 w-5" />
              <span>More</span>
            </button>
          )}
        </nav>
      </div>

      {/* Phone: full-nav drawer with an explicit close button */}
      <Sheet
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        side="left"
        ariaLabel="Navigation menu"
        className="bg-sidebar text-sidebar-foreground"
      >
        {/* pt-safe: viewportFit=cover means the drawer starts under the notch. */}
        <div className="flex h-full min-h-0 flex-col pt-safe">
          <div className="flex items-center justify-between pr-2">
            <Brand role={user.role} />
            <button
              onClick={() => setDrawerOpen(false)}
              aria-label="Close menu"
              className="flex h-11 w-11 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-white/10 hover:text-white"
            >
              <X className="h-6 w-6" />
            </button>
          </div>
          <NavList nav={nav} onNavigate={() => setDrawerOpen(false)} />
          <UserFooter user={user} />
        </div>
      </Sheet>
    </div>
  );
}

function Brand({ role }: { role: string }) {
  return (
    <div className="flex items-center gap-2.5 px-5 py-5">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-base font-semibold text-white">
        M
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold text-white">Meridian Wellness</div>
        <div className="text-[11px] text-sidebar-foreground/60">{role}</div>
      </div>
    </div>
  );
}

function BrandMark() {
  return (
    <div className="flex items-center justify-center py-5">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-base font-semibold text-white">
        M
      </div>
    </div>
  );
}
