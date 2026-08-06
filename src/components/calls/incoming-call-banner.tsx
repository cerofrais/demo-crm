"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/demo/session-client";
import { Phone, X } from "lucide-react";
import { api } from "@/lib/client";

// Fast enough that a rep sees this within a couple of seconds of the phone
// actually ringing — the hunt-to-next-rep timeout is 45s per hop, so this
// still needs to be well under that.
const POLL_MS = 2000;

interface RingingCall {
  callId: string;
  customerPhone: string;
  guestId: string | null;
  guestName: string | null;
  isReturning: boolean;
  startedAt: string;
}

/**
 * The rep's physical phone only ever shows the Plivo number calling them —
 * this polls for a call currently ringing for the signed-in user and shows
 * who's actually on the line, so the rep isn't answering blind.
 */
export function IncomingCallBanner() {
  const { status } = useSession();
  const [call, setCall] = useState<RingingCall | null>(null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const notified = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;

    async function poll() {
      try {
        const data = await api.get<RingingCall | null>("/api/calls/ringing");
        if (cancelled) return;
        setCall(data);
        if (data && !notified.current.has(data.callId)) {
          notified.current.add(data.callId);
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification("Incoming call", {
              body: data.guestName ? `${data.guestName} — ${data.customerPhone}` : data.customerPhone,
              tag: "incoming-call",
            });
          }
        }
      } catch {
        // transient — next tick retries
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status]);

  // Best-effort — a rep who never grants this just gets the in-app banner,
  // which works regardless.
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  if (!call || call.callId === dismissedId) return null;

  return (
    <div className="fixed right-4 top-4 z-[100] w-80 rounded-lg border border-brand-300 bg-white p-4 shadow-xl">
      <div className="flex items-start gap-3">
        <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700">
          <Phone className="h-4 w-4" />
          <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-500" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-brand-700">Incoming call</p>
          <p className="truncate text-sm font-semibold text-foreground">
            {call.guestName ?? "Unknown caller"}
            {call.isReturning && (
              <span className="ml-1.5 rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">
                Returning
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">{call.customerPhone}</p>
          {call.guestId && (
            <a
              href={`/guests?q=${encodeURIComponent(call.customerPhone)}`}
              className="mt-1.5 inline-block text-xs font-medium text-brand-700 underline-offset-2 hover:underline"
            >
              View guest
            </a>
          )}
        </div>
        <button
          onClick={() => setDismissedId(call.callId)}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          title="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
