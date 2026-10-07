"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, Tag as TagIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTag } from "@/lib/lead-tags";
import type { TagMatch } from "@/lib/tag-match";
import { TagMatchToggle } from "./tag-match-toggle";

/**
 * Tag filter bar — stays pinned to ONE row (horizontal scroll on the chip
 * list only, never wraps) regardless of how many distinct tags exist across
 * the loaded leads. On a narrow phone screen, a straight list of every tag
 * as a chip (campaign tags especially — often one per ad campaign) could
 * wrap to several rows and push the actual lead list off-screen before a
 * rep sees anything.
 *
 * Browsing/selecting from the full tag universe moves into a "Tags" popover
 * with a substring search instead of showing every tag inline; only the
 * tags a rep has actually activated stay visible in the bar itself. A
 * collapse toggle hides the whole row (down to a small "Show tags" pill)
 * for when even that one line isn't wanted.
 *
 * The popover trigger deliberately sits OUTSIDE the horizontally-scrolling
 * chip region (not nested inside it) — an `overflow-x-auto` ancestor also
 * clips vertical overflow (per the CSS overflow spec, setting only one axis
 * computes the other to `auto` too), which was cutting the popover off /
 * rendering it underneath whatever sat below the bar (the kanban board).
 */
export function TagFilterBar({
  availableTags,
  activeTags,
  onToggle,
  onClear,
  match,
  onMatchChange,
}: {
  availableTags: string[];
  activeTags: string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
  /** Any/All. Optional: a page that doesn't pass it (the report screens,
   *  whose tag list defines what the report IS) keeps its fixed meaning and
   *  shows no toggle. */
  match?: TagMatch;
  onMatchChange?: (match: TagMatch) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery("");
  }, [open]);

  if (availableTags.length === 0) return null;

  if (collapsed) {
    return (
      <div className="border-b border-border bg-background px-4 py-1.5 md:px-6">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-secondary"
        >
          <TagIcon className="h-3 w-3" />
          Show tags{activeTags.length > 0 ? ` (${activeTags.length})` : ""}
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const matches = q ? availableTags.filter((t) => formatTag(t).label.toLowerCase().includes(q)) : availableTags;

  return (
    <div className="flex items-center gap-1.5 border-b border-border bg-background px-4 py-2 md:px-6">
      <div ref={rootRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
            open ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary",
          )}
        >
          <Search className="h-3 w-3" />
          Tags
        </button>

        {open && (
          <div className="absolute left-0 top-full z-50 mt-1 w-60 rounded-md border border-border bg-popover shadow-lg">
            <div className="border-b border-border p-1.5">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search tags…"
                className="w-full rounded border border-input bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div className="max-h-60 overflow-y-auto p-1.5">
              {matches.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">No matching tags.</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {matches.map((t) => {
                    const f = formatTag(t);
                    const active = activeTags.includes(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => onToggle(t)}
                        className={cn(
                          "rounded-full px-2.5 py-0.5 text-xs font-medium transition-all",
                          active ? "bg-brand-700 text-white ring-2 ring-brand-300" : `${f.className} hover:opacity-80`,
                        )}
                      >
                        {f.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Only this region scrolls — a long list of active filters still
          fits in one row without pushing the Tags/Hide buttons off-screen,
          and (per the class comment above) it's what would clip the
          popover if the trigger were nested inside it instead. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {activeTags.map((t) => {
          const f = formatTag(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => onToggle(t)}
              title="Remove filter"
              className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-brand-700 px-2.5 py-0.5 text-xs font-medium text-white"
            >
              {f.label}
              <X className="h-3 w-3" />
            </button>
          );
        })}
      </div>

      {/* Only meaningful from two tags up — with one, "any" and "all" are
          the same filter, so the toggle would just be noise. */}
      {match && onMatchChange && activeTags.length >= 2 && (
        <TagMatchToggle value={match} onChange={onMatchChange} className="border-l border-border pl-2" />
      )}

      {activeTags.length > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 whitespace-nowrap text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
        >
          Clear
        </button>
      )}

      <button
        type="button"
        onClick={() => setCollapsed(true)}
        title="Hide tags"
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
