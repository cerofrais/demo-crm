"use client";

import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { cn, formatIST } from "@/lib/utils";
import { formatTag, whatsAppNumberTag } from "@/lib/lead-tags";

/**
 * How long a rep can still reply to this guest in free text.
 *
 * Meta allows a free-form WhatsApp reply only within 24 hours of the
 * customer's own last message; after that a send is refused with error
 * 131047 and only an approved template goes through. Reps had no way to see
 * that before hitting send — the first sign was a red "Failed" on a message
 * they had already written — so the remaining time is shown on the card.
 *
 * The window is Meta's, counted PER NUMBER, so the line it is open on is
 * named in the tooltip: replying from a different one of our numbers is
 * refused no matter how recent the conversation looks, which is what 331 of
 * this deployment's 373 such failures actually were.
 *
 * Renders nothing once the window has closed. A closed window is the normal
 * state for most leads on the board, and a chip on nearly every card would
 * carry no information; the presence of the chip IS the signal.
 */
export function WhatsAppWindowChip({
  window: win,
  className,
}: {
  window: { expiresAt: string; ourNumber: string | null };
  className?: string;
}) {
  // Deliberately null on first render: the server has no idea what time it is
  // in the viewer's browser, so computing this during SSR would hydrate with a
  // different string than it rendered and React would warn. Mount, then tick.
  const [msLeft, setMsLeft] = useState<number | null>(null);

  useEffect(() => {
    const expiry = new Date(win.expiresAt).getTime();
    if (!Number.isFinite(expiry)) return;
    const tick = () => setMsLeft(expiry - Date.now());
    tick();
    // A minute is the display resolution, so a minute is the tick rate — this
    // renders once per card on a board that can hold hundreds.
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [win.expiresAt]);

  if (msLeft === null || msLeft <= 0) return null;

  const totalMinutes = Math.floor(msLeft / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const label = hours > 0 ? `${hours}h ${minutes}m` : totalMinutes > 0 ? `${minutes}m` : "<1m";

  // Under two hours the window stops being something to note and becomes
  // something to act on before it shuts.
  const urgent = msLeft < 2 * 60 * 60 * 1000;

  const numberTag = whatsAppNumberTag(win.ourNumber);
  const numberLabel = numberTag ? formatTag(numberTag).label : "this number";

  return (
    <span
      title={
        `Free-text reply window closes ${formatIST(win.expiresAt, { hour: "2-digit", minute: "2-digit" })} ` +
        `on ${numberLabel} — after that this guest can only be sent an approved template, ` +
        `and only from that same number.`
      }
      className={cn(
        // `relative` anchors any absolutely-positioned child (the sr-only
        // label below) to this chip. Without it Tailwind's .sr-only resolves
        // against <html> and lands at its static position far down a scrolled
        // column, stretching the document — see lead-card.tsx.
        "relative flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold leading-none",
        urgent ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800",
        className,
      )}
    >
      <Timer className="h-2.5 w-2.5" aria-hidden />
      {label}
      <span className="sr-only">left to reply in free text on {numberLabel}</span>
    </span>
  );
}
