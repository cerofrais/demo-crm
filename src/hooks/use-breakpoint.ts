"use client";

import { useEffect, useState } from "react";

/**
 * SSR-safe viewport-tier hook. CSS (Tailwind `md:`/`lg:`) is the primary tool for
 * responsiveness — reach for this ONLY when a component must branch in JS
 * (e.g. render the Kanban board vs. the stage-tab component, or a `<table>` vs.
 * a card list that are structurally different components).
 *
 * Tiers match the Tailwind defaults used across the app:
 *   phone   : < 768px  (base)
 *   tablet  : 768–1023 (md)
 *   desktop : >= 1024  (lg)
 *
 * On the server (and first client render) it returns `desktop` so markup is
 * deterministic; it re-measures on mount, so guard against layout-flash by
 * preferring CSS for anything above the fold.
 */
export type Breakpoint = "phone" | "tablet" | "desktop";

const MD = 768;
const LG = 1024;

function measure(): Breakpoint {
  if (typeof window === "undefined") return "desktop";
  const w = window.innerWidth;
  if (w < MD) return "phone";
  if (w < LG) return "tablet";
  return "desktop";
}

export function useBreakpoint(): {
  breakpoint: Breakpoint;
  isPhone: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  /** true once measured on the client — use to defer JS-branched UI past hydration. */
  mounted: boolean;
} {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>("desktop");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const update = () => setBreakpoint(measure());
    update();
    setMounted(true);
    // matchMedia listeners fire only on tier crossings — cheaper than resize.
    const mqMd = window.matchMedia(`(min-width: ${MD}px)`);
    const mqLg = window.matchMedia(`(min-width: ${LG}px)`);
    mqMd.addEventListener("change", update);
    mqLg.addEventListener("change", update);
    return () => {
      mqMd.removeEventListener("change", update);
      mqLg.removeEventListener("change", update);
    };
  }, []);

  return {
    breakpoint,
    isPhone: breakpoint === "phone",
    isTablet: breakpoint === "tablet",
    isDesktop: breakpoint === "desktop",
    mounted,
  };
}
