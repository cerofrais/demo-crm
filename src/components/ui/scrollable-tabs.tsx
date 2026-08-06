"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Horizontally scrollable underline tab bar. Tabs that overflow (e.g. the lead
 * drawer's 8 tabs on a phone) scroll sideways instead of wrapping/crowding; the
 * active tab is scrolled into view. 44px min height for touch.
 *
 * Overflow is only discoverable via `overflow-x-auto`'s native scrollbar,
 * which mobile/trackpad browsers auto-hide — so tabs past the fold (e.g.
 * "Activity", last in the lead drawer) looked like they'd disappeared. Chevron
 * buttons flanking the strip make the overflow visible regardless of scrollbar
 * visibility; they are flex siblings (never overlaying the tabs).
 */
export interface TabItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
}

export function ScrollableTabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: TabItem[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const listRef = React.useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(false);
  // Whether the strip overflows at all. Both chevrons render together whenever
  // it does (each disabled at its end) so their width never changes mid-scroll —
  // mounting/unmounting one would resize the scroller and can oscillate.
  const [isScrollable, setIsScrollable] = React.useState(false);

  const updateScrollState = React.useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setIsScrollable(el.scrollWidth > el.clientWidth + 1);
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  // Labels carry live counts in some consumers (e.g. "Contacted (12)"), so the
  // content width can change without tabs.length or the container resizing —
  // key the effect on the rendered labels, not just the count.
  const labelSignature = tabs.map((t) => `${t.key}:${t.label}`).join("|");

  React.useEffect(() => {
    updateScrollState();
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateScrollState, labelSignature]);

  // Re-run when isScrollable flips: the chevrons mounting changes the scroller's
  // width, so a centering done before that lands off-centre.
  React.useEffect(() => {
    refs.current[active]?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [active, isScrollable]);

  function scrollBy(delta: number) {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    listRef.current?.scrollBy({ left: delta, behavior: reduced ? "auto" : "smooth" });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const idx = tabs.findIndex((t) => t.key === active);
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    const key = tabs[next].key;
    onChange(key);
    refs.current[key]?.focus();
  }

  return (
    // Chevrons are flex SIBLINGS of the scroller, not absolutely positioned over
    // it — overlaying them covered the first/last tab and swallowed taps meant
    // for that tab.
    <div className={cn("flex items-stretch border-b border-border", className)}>
      {isScrollable && (
        <button
          type="button"
          aria-label="Scroll tabs left"
          disabled={!canScrollLeft}
          onClick={() => scrollBy(-120)}
          className="flex w-11 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}
      <div
        ref={listRef}
        role="tablist"
        onKeyDown={onKeyDown}
        onScroll={updateScrollState}
        className="scrollbar-thin flex min-w-0 flex-1 gap-1 overflow-x-auto px-2"
      >
        {tabs.map((t) => {
          const selected = t.key === active;
          return (
            <button
              key={t.key}
              ref={(el) => {
                refs.current[t.key] = el;
              }}
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.key)}
              className={cn(
                "flex min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors",
                selected
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.icon}
              {t.label}
            </button>
          );
        })}
      </div>

      {isScrollable && (
        <button
          type="button"
          aria-label="Scroll tabs right"
          disabled={!canScrollRight}
          onClick={() => scrollBy(120)}
          className="flex w-11 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
