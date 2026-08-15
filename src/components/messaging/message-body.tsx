"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { cleanMessageBody, isLongMessage } from "@/lib/message-display";

/**
 * A message body as a human wants to read it: tracking pixels gone, links
 * shortened to their domain, and anything long collapsed — with the exact
 * stored text one click away.
 *
 * The cleaning is display-only. `original` is always what was received, and
 * "Show original" reveals it verbatim, so nothing is hidden from someone who
 * needs to see precisely what a guest sent.
 */
export function MessageBody({ body, className }: { body: string; className?: string }) {
  const [showOriginal, setShowOriginal] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const cleaned = useMemo(() => cleanMessageBody(body), [body]);
  const text = showOriginal ? cleaned.original : cleaned.clean;
  const long = isLongMessage(text);
  const collapsed = long && !expanded;

  // Only worth offering the original when it actually differs.
  const note =
    cleaned.trackersRemoved > 0
      ? `${cleaned.trackersRemoved} tracking link${cleaned.trackersRemoved === 1 ? "" : "s"} hidden`
      : cleaned.linksShortened > 0
        ? `${cleaned.linksShortened} link${cleaned.linksShortened === 1 ? "" : "s"} shortened`
        : null;

  return (
    <div className={className}>
      <div
        className={cn(
          "whitespace-pre-wrap break-words text-foreground",
          collapsed && "line-clamp-[12]",
        )}
      >
        {text}
      </div>

      {(long || cleaned.changed) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
          {long && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="font-medium text-brand-600 hover:underline"
            >
              {expanded ? "Show less" : "Show full message"}
            </button>
          )}
          {cleaned.changed && (
            <button
              onClick={() => setShowOriginal((v) => !v)}
              className="text-muted-foreground hover:underline"
            >
              {showOriginal ? "Hide original" : "Show original"}
            </button>
          )}
          {note && !showOriginal && <span className="text-muted-foreground/70">{note}</span>}
        </div>
      )}
    </div>
  );
}
