"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A custom, always-visible horizontal scroll track/thumb for a scrollable
 * element — doesn't rely on the browser's native scrollbar rendering at
 * all, since recent Chrome auto-hides even CSS-styled (::-webkit-scrollbar)
 * scrollbars as an overlay, regardless of styling. Click-to-jump or
 * drag-the-thumb both work, same as a native scrollbar would.
 */
export function HorizontalScrollbar({
  targetRef,
  className,
}: {
  targetRef: React.RefObject<HTMLElement>;
  className?: string;
}) {
  const [thumb, setThumb] = useState({ leftPct: 0, widthPct: 100 });
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;

    function update() {
      const { scrollWidth, clientWidth, scrollLeft } = el!;
      if (scrollWidth <= clientWidth + 1) {
        setThumb({ leftPct: 0, widthPct: 100 });
        return;
      }
      setThumb({
        widthPct: (clientWidth / scrollWidth) * 100,
        leftPct: (scrollLeft / scrollWidth) * 100,
      });
    }

    update();
    el.addEventListener("scroll", update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [targetRef]);

  function scrollToRatio(clientX: number) {
    const el = targetRef.current;
    const track = trackRef.current;
    if (!el || !track) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    el.scrollLeft = ratio * el.scrollWidth - el.clientWidth / 2;
  }

  function onTrackClick(e: React.MouseEvent) {
    // Ignore clicks that started the thumb drag — that has its own handler.
    if (e.target !== trackRef.current) return;
    scrollToRatio(e.clientX);
  }

  function onThumbMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const el = targetRef.current;
    const track = trackRef.current;
    if (!el || !track) return;
    const rect = track.getBoundingClientRect();
    const startX = e.clientX;
    const startScrollLeft = el.scrollLeft;

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const ratio = dx / rect.width;
      el!.scrollLeft = startScrollLeft + ratio * el!.scrollWidth;
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Nothing to scroll — no point showing a full-width, non-functional bar.
  if (thumb.widthPct >= 100) return null;

  return (
    <div
      ref={trackRef}
      onClick={onTrackClick}
      className={cn("h-4 w-full shrink-0 cursor-pointer rounded-full bg-secondary", className)}
    >
      <div
        onMouseDown={onThumbMouseDown}
        className="h-full cursor-grab rounded-full bg-border transition-colors hover:bg-brand-400 active:cursor-grabbing active:bg-brand-500"
        style={{ width: `${thumb.widthPct}%`, marginLeft: `${thumb.leftPct}%` }}
      />
    </div>
  );
}
