"use client";

/**
 * Playing a call recording.
 *
 * A row in a call list is a cramped place for an audio element: the scrubber
 * is a few pixels wide, the controls fight the columns either side, and on a
 * phone it wraps the row. A Play button that opens the recording over the page
 * gives it room, and closing returns to exactly the row you were on — the same
 * behaviour as a photo in the activity log.
 */

import { useState } from "react";
import { Play } from "lucide-react";
import { MediaOverlay } from "@/components/media/media-overlay";

interface Props {
  callId: string;
  durationSec?: number | null;
  /** Shown in the overlay's title bar, e.g. the guest's name. */
  label?: string | null;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function RecordingPlayer({ callId, durationSec, label }: Props) {
  const [open, setOpen] = useState(false);
  const src = `/api/calls/${callId}/recording`;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={(e) => {
          // Call rows are clickable in places; playing is not navigating.
          e.stopPropagation();
          setOpen(true);
        }}
        className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
        title="Play this recording"
      >
        <Play className="h-3.5 w-3.5 text-brand-600" />
        Play
        {durationSec != null && durationSec > 0 && (
          <span className="text-muted-foreground">{fmt(durationSec)}</span>
        )}
      </button>

      {open && (
        <div onClick={(e) => e.stopPropagation()}>
          <MediaOverlay
            media={{ id: callId, filename: `call-${callId}.mp3`, mimeType: "audio/mpeg" }}
            srcOverride={src}
            title={label ? `Call with ${label}` : "Call recording"}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
