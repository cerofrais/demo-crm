"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";
import { TAG_MATCH_LABEL, type TagMatch } from "@/lib/tag-match";

/**
 * "Any tag / All tags" — whether a tag filter shows items carrying any of the
 * selected tags or every one of them. Real radio inputs (not two buttons
 * styled as tabs), so the choice is announced and arrow-key navigable.
 */
export function TagMatchToggle({
  value,
  onChange,
  className,
}: {
  value: TagMatch;
  onChange: (value: TagMatch) => void;
  className?: string;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label="Match tags"
      className={cn("flex shrink-0 items-center gap-2 text-xs text-muted-foreground", className)}
    >
      <span className="hidden sm:inline">Match</span>
      {(["any", "all"] as const).map((mode) => (
        <label key={mode} className="flex cursor-pointer items-center gap-1 whitespace-nowrap">
          <input
            type="radio"
            name={name}
            value={mode}
            checked={value === mode}
            onChange={() => onChange(mode)}
            className="h-3 w-3 accent-brand-700"
          />
          <span className={cn(value === mode && "font-medium text-foreground")}>{TAG_MATCH_LABEL[mode]}</span>
        </label>
      ))}
    </div>
  );
}
