"use client";

import { useEffect, useRef, useState } from "react";
import { LayoutTemplate, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { personalizeTemplate, type MessageTemplateDTO, type MessageTemplateChannel } from "@/lib/message-templates";

interface MeProfile {
  displayName: string;
  phone: string | null;
}

/**
 * "Templates" button + popover list, shared by all four send surfaces
 * (individual WhatsApp/email, bulk WhatsApp/email). Fetches templates for
 * `channel` lazily on first open, plus the current staff member's own
 * name/phone — {rep_name}/{rep_phone} are resolved here, before the
 * template ever reaches the caller, since the sender is always known
 * immediately. {name} (the guest's name) is deliberately left untouched:
 * the caller resolves it however fits — immediately for an individual
 * composer (recipient already known), or left as a token for bulk sends
 * (resolved per-recipient server-side at send time).
 */
export function TemplatePicker({
  channel,
  onSelect,
  openUpward = false,
  align = "right",
}: {
  channel: MessageTemplateChannel;
  onSelect: (t: MessageTemplateDTO) => void;
  openUpward?: boolean;
  /** Which side of the button the popover's edge anchors to — "left" opens
   *  rightward (use when the button sits near the left of a wide row, e.g.
   *  a compose bar, so the popover doesn't run off the panel's left edge). */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<MessageTemplateDTO[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [me, setMe] = useState<MeProfile | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  function openPicker() {
    setOpen((o) => !o);
    if (templates === null) {
      setLoading(true);
      Promise.all([
        api.get<MessageTemplateDTO[]>(`/api/message-templates?channel=${channel}`),
        api.get<MeProfile>("/api/staff-profiles/me").catch(() => null),
      ])
        .then(([tpls, meProfile]) => {
          setTemplates(tpls);
          setMe(meProfile);
        })
        .catch(() => setTemplates([]))
        .finally(() => setLoading(false));
    }
  }

  function pick(t: MessageTemplateDTO) {
    const vars = { repName: me?.displayName, repPhone: me?.phone ?? undefined };
    onSelect({
      ...t,
      subject: t.subject ? personalizeTemplate(t.subject, vars) : t.subject,
      body: personalizeTemplate(t.body, vars),
    });
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <Button type="button" variant="outline" size="icon" onClick={openPicker} title="Insert a template">
        <LayoutTemplate className="h-4 w-4" />
      </Button>

      {open && (
        <div
          className={cn(
            "absolute z-20 w-64 rounded-md border border-border bg-popover shadow-lg",
            align === "left" ? "left-0" : "right-0",
            openUpward ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          <div className="max-h-72 overflow-y-auto py-1">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            )}
            {!loading && templates?.length === 0 && (
              <p className="px-3 py-3 text-sm text-muted-foreground">No templates yet.</p>
            )}
            {!loading &&
              templates?.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pick(t)}
                  className="block w-full truncate px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-secondary"
                >
                  {t.name}
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
