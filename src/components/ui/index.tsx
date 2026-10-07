"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/* Minimal, brand-themed UI primitives (shadcn-style, no external dep). */

export { Sheet, Dialog } from "./sheet";
export type { SheetProps, DialogProps } from "./sheet";
export { ScrollableTabs } from "./scrollable-tabs";
export type { TabItem } from "./scrollable-tabs";
export { HorizontalScrollbar } from "./horizontal-scrollbar";
export { RichTextEditor } from "./rich-text-editor";
export type { RichTextEditorProps } from "./rich-text-editor";

// ---- Button ----
const buttonVariants = {
  primary:
    "bg-primary text-primary-foreground hover:bg-brand-600 shadow-sm",
  secondary:
    "bg-secondary text-secondary-foreground hover:bg-brand-100 border border-border",
  ghost: "hover:bg-secondary text-foreground",
  outline: "border border-border bg-background hover:bg-secondary",
  destructive: "bg-destructive text-destructive-foreground hover:opacity-90",
} as const;

const buttonSizes = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
  lg: "h-11 px-6 text-base",
  // 44px hit target on phones, compact on desktop.
  icon: "h-11 w-11 lg:h-9 lg:w-9",
} as const;

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof buttonVariants;
  size?: keyof typeof buttonSizes;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";

// ---- Card ----
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card text-card-foreground shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

// ---- Badge ----
export function Badge({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        className,
      )}
      {...props}
    />
  );
}

// ---- ScoreBadge ----
/**
 * Small hollow ring for an AI score (0-100), the number itself sitting
 * inside — click still reveals the "AI Score: n/100" popover for the
 * full-context label. Consolidates the >=70 green / 40-69 amber / <40 red
 * convention that was previously duplicated (and slightly inconsistent)
 * across calls-panel, the calls list, lead-card and assist-panel.
 */
export function ScoreBadge({
  score,
  className,
}: {
  score: number | null;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  if (score === null) return null;
  const color =
    score >= 70
      ? "border-emerald-500 text-emerald-600"
      : score >= 40
        ? "border-amber-500 text-amber-600"
        : "border-rose-500 text-rose-600";

  return (
    <span ref={rootRef} className={cn("relative inline-flex", className)}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title="AI score"
        aria-label={`AI score ${score} out of 100`}
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 bg-background text-[8px] font-bold leading-none tabular-nums",
          color,
        )}
      >
        {score}
      </button>
      {open && (
        <span className="absolute left-1/2 top-full z-20 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-lg">
          AI Score: {score}/100
        </span>
      )}
    </span>
  );
}

// ---- Input ----
/**
 * Input types whose value is picked, not typed.
 *
 * Chrome only opens the picker from the small calendar glyph at the right
 * edge — clicking the field itself does nothing. In a date field narrow
 * enough to sit in a toolbar that glyph is a few pixels wide, so the control
 * reads as broken: people click it, nothing happens, and they assume there is
 * no picker. Clicking anywhere in the field opens it instead.
 */
const PICKER_INPUT_TYPES = new Set(["date", "datetime-local", "time", "month", "week"]);

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, onClick, ...props }, ref) => (
  <input
    ref={ref}
    onClick={(e) => {
      if (props.type && PICKER_INPUT_TYPES.has(props.type)) {
        // Not supported everywhere, and it throws when the browser decides
        // the click was not a real user gesture. Either way the field still
        // accepts typing, so a failure costs nothing.
        try {
          (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
        } catch {
          /* typing still works */
        }
      }
      onClick?.(e);
    }}
    className={cn(
      // text-base on phones prevents iOS auto-zoom on focus; h-11 = 44px target.
      "flex h-11 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 lg:h-9 lg:text-sm",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

// ---- Select (native) ----
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "flex h-11 w-full rounded-md border border-input bg-background px-3 text-base shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:h-9 lg:text-sm",
      className,
    )}
    {...props}
  />
));
Select.displayName = "Select";

// ---- Textarea ----
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:text-sm",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

// ---- Avatar (initials) ----
export function Avatar({ name, className }: { name?: string | null; className?: string }) {
  return (
    <div
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700",
        className,
      )}
    >
      {(name ?? "?")
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase() ?? "")
        .join("")}
    </div>
  );
}
