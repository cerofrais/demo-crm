"use client";

import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { toWaMeDigits } from "@/lib/wa-me";

interface Props {
  enquiryId: string;
  customerPhone: string | null;
  className?: string;
}

/**
 * Opens a wa.me deep link for `customerPhone` — hands off to the WhatsApp
 * app (or web.whatsapp.com if not installed) on the chat with that number,
 * for the rep to place a WhatsApp voice/video call themselves. There's no
 * documented wa.me parameter to auto-dial a call, so this is the reliable,
 * cross-platform stopping point — meant for numbers Plivo can't reach
 * cost-effectively (e.g. international), as an alternative to CallButton.
 */
export function WhatsAppCallButton({ enquiryId, customerPhone, className }: Props) {
  if (!customerPhone) return null;
  const digits = toWaMeDigits(customerPhone);
  if (!digits) return null;

  function handleClick() {
    // window.open must run synchronously in the click handler or popup
    // blockers treat it as not user-initiated — fire the audit log
    // afterward, without awaiting it, so it can never delay/block the open.
    window.open(`https://wa.me/${digits}`, "_blank", "noopener,noreferrer");
    api.post(`/api/enquiries/${enquiryId}/whatsapp-call`, {}).catch(() => {
      // Non-fatal — the rep already got to WhatsApp; losing the audit log
      // entry isn't worth surfacing an error for.
    });
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={handleClick}
      className={cn("gap-1.5 border-green-600/40 text-green-700 hover:bg-green-50", className)}
      title="Open WhatsApp to call this number"
    >
      <MessageCircle className="h-3.5 w-3.5" />
      WhatsApp Call
    </Button>
  );
}
