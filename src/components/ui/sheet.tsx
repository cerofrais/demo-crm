"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Overlay primitives: `Sheet` (slides from a side or the bottom) and `Dialog`
 * (centered on tablet/desktop, bottom-sheet on phone). Both handle the things
 * the app's hand-rolled `fixed inset-0` modals were missing: a body-portal,
 * backdrop dismiss, `Esc`, scroll lock, focus trap, and focus restore.
 */

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

/**
 * Stack of currently-open overlays. Only the TOPMOST one reacts to Esc/Tab —
 * without this a nested Dialog (e.g. the delete-confirm inside the lead drawer)
 * and its parent Sheet both fire on one Esc and close together.
 */
const overlayStack: symbol[] = [];

/**
 * Scroll lock, refcounted. The app's scroll element is `<main data-scroll-container>`
 * (the shell is h-[100dvh] overflow-hidden), NOT <body> — locking body was a no-op
 * and the page kept scrolling behind open overlays. Falls back to <body> for
 * pages rendered outside the shell (e.g. /login).
 */
let lockCount = 0;
let lockedEls: HTMLElement[] = [];
let prevOverflows: string[] = [];

function lockScroll() {
  if (lockCount === 0) {
    // Lock EVERY marked scroller, not just the first: screens like the Kanban and
    // the health workspace are h-full and scroll in a nested container, so <main>
    // never scrolls there and locking only it would be a no-op.
    const found = Array.from(
      document.querySelectorAll<HTMLElement>("[data-scroll-container]"),
    );
    lockedEls = found.length > 0 ? found : [document.body];
    prevOverflows = lockedEls.map((el) => el.style.overflow);
    lockedEls.forEach((el) => {
      el.style.overflow = "hidden";
    });
  }
  lockCount += 1;
}

function unlockScroll() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    lockedEls.forEach((el, i) => {
      el.style.overflow = prevOverflows[i] ?? "";
    });
    lockedEls = [];
    prevOverflows = [];
  }
}

function useOverlayBehavior(
  open: boolean,
  onClose: () => void,
  panelRef: React.RefObject<HTMLElement>,
) {
  // Keep onClose in a ref so consumers can pass an inline arrow without the
  // effect tearing down on every parent re-render (which would steal focus back
  // to the first field and thrash the scroll-lock on each keystroke).
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  });

  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const id = Symbol("overlay");
    overlayStack.push(id);

    lockScroll();

    // Move focus into the panel.
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const isTopmost = () => overlayStack[overlayStack.length - 1] === id;

    function onKeyDown(e: KeyboardEvent) {
      // Only the topmost overlay handles keys, so a nested Dialog doesn't also
      // close its parent Sheet (and the parent doesn't steal the nested Tab trap).
      if (!isTopmost()) return;
      if (e.key === "Escape") {
        // stopPropagation alone does NOT stop other listeners on the same node
        // (document) — that needs stopImmediatePropagation.
        e.stopImmediatePropagation();
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const i = overlayStack.indexOf(id);
      if (i !== -1) overlayStack.splice(i, 1);
      unlockScroll();
      previouslyFocused?.focus?.();
    };
    // Depends only on `open` — onClose is read through a ref so re-renders while
    // the overlay is open don't re-run this (and re-steal focus).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/** True only after mount so we can portal to document.body without SSR mismatch. */
function useMounted() {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted;
}

type SheetSide = "left" | "right" | "bottom";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  side?: SheetSide;
  title?: React.ReactNode;
  /** Accessible label when there's no visible title. */
  ariaLabel?: string;
  /** Override the default panel width (left/right). e.g. "w-full max-w-3xl". */
  widthClassName?: string;
  /**
   * When true (default) children are wrapped in a scroll container. Set false
   * for panels that manage their own internal layout/scroll (e.g. a fixed
   * header + tabs + scrolling body like the lead drawer).
   */
  scrollBody?: boolean;
  className?: string;
  children: React.ReactNode;
}

const sidePosition: Record<SheetSide, string> = {
  left: "inset-y-0 left-0 h-full border-r",
  right: "inset-y-0 right-0 h-full border-l",
  // pb-safe: clears the iOS home indicator, otherwise the last row of a bottom
  // sheet (e.g. the last stage in "Move to stage") sits under it.
  bottom: "inset-x-0 bottom-0 max-h-[90dvh] w-full rounded-t-2xl border-t pb-safe",
};

const defaultWidth: Record<SheetSide, string> = {
  left: "w-[85%] max-w-sm",
  right: "w-[85%] max-w-sm",
  bottom: "",
};

const sideAnim: Record<SheetSide, string> = {
  left: "animate-slide-in-left",
  right: "animate-slide-in-right",
  bottom: "animate-slide-in-bottom",
};

export function Sheet({
  open,
  onClose,
  side = "right",
  title,
  ariaLabel,
  widthClassName,
  scrollBody = true,
  className,
  children,
}: SheetProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const mounted = useMounted();
  // Gate on `mounted` too: on the first commit the portal hasn't rendered yet, so
  // panelRef.current is still null. Running the effect then captured a null panel
  // for its lifetime — no initial focus and NO Tab containment for every overlay
  // that's conditionally mounted with `open` hard-coded (most of them).
  useOverlayBehavior(mounted && open, onClose, panelRef);

  if (!mounted || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/40 animate-overlay-in motion-reduce:animate-none"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={cn(
          "absolute flex flex-col bg-background shadow-xl outline-none border-border",
          "min-h-0 overflow-hidden",
          sidePosition[side],
          widthClassName ?? defaultWidth[side],
          sideAnim[side],
          "motion-reduce:animate-none",
          className,
        )}
      >
        {(title || side === "bottom") && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div className="text-sm font-semibold">{title}</div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary lg:h-9 lg:w-9"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}
        {scrollBody ? (
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        ) : (
          children
        )}
      </div>
    </div>,
    document.body,
  );
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  ariaLabel?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Centered modal on tablet/desktop; on phone it becomes a bottom sheet so the
 * content sits under the thumb instead of floating mid-screen.
 */
export function Dialog({ open, onClose, title, ariaLabel, className, children }: DialogProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const mounted = useMounted();
  // Gate on `mounted` too: on the first commit the portal hasn't rendered yet, so
  // panelRef.current is still null. Running the effect then captured a null panel
  // for its lifetime — no initial focus and NO Tab containment for every overlay
  // that's conditionally mounted with `open` hard-coded (most of them).
  useOverlayBehavior(mounted && open, onClose, panelRef);

  if (!mounted || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-4">
      <div
        className="absolute inset-0 bg-black/40 animate-overlay-in motion-reduce:animate-none"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={cn(
          "relative z-10 flex max-h-[90dvh] w-full flex-col overflow-hidden bg-background shadow-xl outline-none",
          // pb-safe clears the iOS home indicator in the phone bottom-sheet form.
          "rounded-t-2xl pb-safe md:max-w-md md:rounded-xl md:pb-0",
          "animate-slide-in-bottom md:animate-zoom-in motion-reduce:animate-none",
          className,
        )}
      >
        {title && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div className="text-sm font-semibold">{title}</div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary lg:h-9 lg:w-9"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
