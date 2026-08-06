"use client";

import { useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "./index";

/**
 * In-browser mic recorder — used both by the WhatsApp panel (voice notes to
 * a guest) and the lead remarks composer (internal audio notes). Produces a
 * plain `File` on stop so callers can drop it straight into whatever
 * attach-a-file flow they already have (upload-url → PUT → confirm) rather
 * than needing a parallel "record and send" path.
 */
export function AudioRecordButton({
  onRecorded,
  disabled,
}: {
  onRecorded: (file: File) => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Chrome/Firefox support webm/opus; Safari doesn't and falls back to
      // its own default (typically mp4/aac) — either is in the storage
      // allowlist (see lib/storage.ts AUDIO_MIME).
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const ext = recorder.mimeType?.includes("mp4") ? "m4a" : "webm";
        onRecorded(new File([blob], `voice-note-${Date.now()}.${ext}`, { type: blob.type }));
      };
      recorder.start();
      recorderRef.current = recorder;
      setSeconds(0);
      setRecording(true);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch (err) {
      // A generic "denied or unavailable" message leaves the most common
      // case — the browser has this exact origin's mic permission stored
      // as Blocked from an earlier denial/different URL, so it never even
      // shows the prompt again — with no way to tell it apart from "no mic
      // installed" or "another app has the mic open". Permissions are
      // strictly per-origin: granting it once on a different host/port
      // doesn't carry over here.
      const name = err instanceof DOMException ? err.name : "";
      setError(
        name === "NotAllowedError"
          ? "Microphone blocked for this site — click the padlock next to the address bar, allow Microphone, then reload."
          : name === "NotFoundError"
            ? "No microphone found on this device."
            : name === "NotReadableError"
              ? "Microphone is in use by another app."
              : "Microphone access denied or unavailable.",
      );
    }
  }

  function stop() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    clearInterval(timerRef.current);
    setRecording(false);
  }

  if (recording) {
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    return (
      <div className="flex items-center gap-1.5">
        <Button type="button" variant="destructive" size="icon" onClick={stop} title="Stop and attach recording">
          <Square className="h-3.5 w-3.5" />
        </Button>
        <span className="flex items-center gap-1 whitespace-nowrap text-xs font-medium text-destructive">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-destructive" />
          {mm}:{ss}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button type="button" variant="outline" size="icon" onClick={start} disabled={disabled} title="Record a voice note">
        <Mic className="h-4 w-4" />
      </Button>
      {error && <span className="max-w-[14rem] text-xs text-destructive">{error}</span>}
    </div>
  );
}
