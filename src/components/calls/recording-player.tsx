"use client";

import { Play, Download } from "lucide-react";

interface Props {
  callId: string;
  durationSec?: number | null;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function RecordingPlayer({ callId, durationSec }: Props) {
  const src = `/api/calls/${callId}/recording`;
  return (
    <div className="flex items-center gap-2">
      <audio
        controls
        preload="none"
        className="h-8 w-full max-w-xs"
        style={{ colorScheme: "normal" }}
      >
        <source src={src} type="audio/mpeg" />
        <source src={src} />
      </audio>
      {durationSec != null && (
        <span className="shrink-0 text-xs text-muted-foreground">{fmt(durationSec)}</span>
      )}
      <a
        href={src}
        download={`call-${callId}.mp3`}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        title="Download recording"
      >
        <Download className="h-4 w-4" />
      </a>
    </div>
  );
}
