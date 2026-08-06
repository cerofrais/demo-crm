"use client";

import { useState } from "react";
import { Phone, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";

interface Props {
  guestId: string;
  enquiryId?: string;
  customerPhone: string | null;
  className?: string;
}

type State = "idle" | "calling" | "ringing" | "error";

export function CallButton({ guestId, enquiryId, customerPhone, className }: Props) {
  const [state, setState] = useState<State>("idle");
  const [msg, setMsg] = useState("");

  if (!customerPhone) return null;

  async function handleCall() {
    if (state === "calling" || state === "ringing") return;
    setState("calling");
    setMsg("");

    try {
      await api.post("/api/calls/initiate", { guestId, enquiryId, customerPhone });
      setState("ringing");
      setMsg("Your phone is ringing…");
      // Reset after 10 s
      setTimeout(() => { setState("idle"); setMsg(""); }, 10_000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Call failed";
      setState("error");
      setMsg(message);
      setTimeout(() => { setState("idle"); setMsg(""); }, 6_000);
    }
  }

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Button
        size="sm"
        variant={state === "ringing" ? "primary" : "outline"}
        onClick={handleCall}
        disabled={state === "calling"}
        className={cn(
          "gap-1.5",
          state === "ringing" && "bg-green-600 text-white hover:bg-green-700",
          state === "error" && "border-destructive text-destructive",
        )}
      >
        {state === "calling" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Phone className="h-3.5 w-3.5" />
        )}
        {state === "calling" ? "Connecting…" : state === "ringing" ? "Calling…" : "Call"}
      </Button>
      {msg && (
        <p className={cn("text-xs", state === "error" ? "text-destructive" : "text-muted-foreground")}>
          {msg}
        </p>
      )}
    </div>
  );
}
