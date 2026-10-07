"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { History, Filter, RefreshCw, Mic, Paperclip } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Card, Select, Input, Button } from "@/components/ui";
import { ACTION_TYPE_OPTIONS, type ActivityListItemDTO } from "@/lib/activity-log";
import { MediaOverlay } from "@/components/media/media-overlay";
import { formatIST } from "@/lib/utils";

interface StaffOption {
  keycloakId: string;
  displayName: string;
}

interface LineOption {
  number: string;
  label: string;
  current: boolean;
}

/**
 * The media on an activity row: an image is shown, audio plays in place, and
 * anything else stays a download. Clicking an image opens the full size in a
 * new tab; the row's own click-through to the lead is suppressed so that
 * looking at a photo doesn't navigate away from the log.
 */
function ActivityAttachment({
  attachment,
}: {
  attachment: { id: string; filename: string; mimeType: string; sizeBytes: number };
}) {
  const [overlay, setOverlay] = useState(false);
  const inline = `/api/files/${attachment.id}?inline=1`;
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  if (attachment.mimeType.startsWith("image/")) {
    return (
      <>
        <button
          type="button"
          onClick={(e) => {
            stop(e);
            setOverlay(true);
          }}
          className="mt-1 block w-fit"
          title={attachment.filename}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={inline}
            alt={attachment.filename}
            loading="lazy"
            className="max-h-28 rounded-md border border-border object-contain transition-opacity hover:opacity-90"
          />
        </button>
        {overlay && (
          <div onClick={stop}>
            <MediaOverlay media={attachment} onClose={() => setOverlay(false)} />
          </div>
        )}
      </>
    );
  }
  if (attachment.mimeType.startsWith("audio/")) {
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <audio controls preload="none" src={inline} onClick={stop} className="mt-1 h-8 w-56 max-w-full" />;
  }
  return (
    <a
      href={`/api/files/${attachment.id}`}
      onClick={stop}
      className="mt-1 flex w-fit max-w-xs items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2 py-1 text-xs hover:bg-secondary/70"
    >
      <Paperclip className="h-3 w-3 shrink-0 text-brand-600" />
      <span className="min-w-0 truncate">{attachment.filename}</span>
    </a>
  );
}

export default function ActivityLogPage() {
  const router = useRouter();
  const [items, setItems] = useState<ActivityListItemDTO[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const [actorSub, setActorSub] = useState("");
  const [actionType, setActionType] = useState("");
  const [lines, setLines] = useState<LineOption[]>([]);
  const [fromNumber, setFromNumber] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    fetch("/api/staff-profiles")
      .then((r) => r.json())
      .then((data: StaffOption[]) => setStaff(data))
      .catch(() => {});
    // Every line that has ever sent from the CRM, current or not.
    fetch("/api/reports/activity/numbers")
      .then((r) => r.json())
      .then((json: { data: LineOption[] }) => setLines(json.data ?? []))
      .catch(() => {});
  }, []);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (actorSub) params.set("actorSub", actorSub);
      if (actionType) params.set("actionType", actionType);
      if (fromNumber) params.set("fromNumber", fromNumber);
      if (from) params.set("from", `${from}T00:00:00`);
      if (to) params.set("to", `${to}T23:59:59`);
      if (cursor) params.set("cursor", cursor);
      try {
        const res = await fetch(`/api/reports/activity?${params}`);
        if (!res.ok) throw new Error(`Failed to load activity (${res.status})`);
        const json = await res.json();
        const data = json.data as { items: ActivityListItemDTO[]; nextCursor: string | null };
        setItems((prev) => (cursor ? [...prev, ...data.items] : data.items));
        setNextCursor(data.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load activity");
      } finally {
        setLoading(false);
      }
    },
    [actorSub, actionType, fromNumber, from, to],
  );

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <PageHeader
        title="Activity Log"
        subtitle="Every staff action across the CRM, plus voice notes guests send in — filter by staff member and date range. Admin/Manager only."
      />

      <div className="flex flex-wrap items-end gap-2 p-4 pb-0 md:p-6 md:pb-0">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Filter className="h-3.5 w-3.5" /> Filters:
        </div>
        <Select value={actorSub} onChange={(e) => setActorSub(e.target.value)} className="w-48 lg:h-8 lg:text-xs">
          <option value="">All staff</option>
          {staff.map((s) => (
            <option key={s.keycloakId} value={s.keycloakId}>{s.displayName}</option>
          ))}
        </Select>
        <Select value={actionType} onChange={(e) => setActionType(e.target.value)} className="w-48 lg:h-8 lg:text-xs">
          <option value="">All actions</option>
          {ACTION_TYPE_OPTIONS.map(([type, label]) => (
            <option key={type} value={type}>{label}</option>
          ))}
        </Select>
        {lines.length > 0 && (
          <Select
            value={fromNumber}
            onChange={(e) => setFromNumber(e.target.value)}
            className="w-56 lg:h-8 lg:text-xs"
            aria-label="WhatsApp number"
          >
            <option value="">All WhatsApp numbers</option>
            {lines.map((l) => (
              <option key={l.number} value={l.number}>
                {l.label}
                {l.current ? "" : " (no longer paired)"}
              </option>
            ))}
          </Select>
        )}
        <Input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-36 lg:h-8 lg:text-xs"
          aria-label="From date"
        />
        <span className="text-xs text-muted-foreground">to</span>
        <Input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-36 lg:h-8 lg:text-xs"
          aria-label="To date"
        />
        <Button size="sm" variant="outline" onClick={() => load()} className="h-8 gap-1 text-xs">
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
      </div>

      <div className="p-4 md:p-6">
        <Card className="overflow-hidden">
          {loading && !items.length ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <History className="mr-2 h-5 w-5 animate-pulse" /> Loading activity…
            </div>
          ) : error && !items.length ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
              <p className="max-w-md text-sm">{error}</p>
              <Button size="sm" variant="outline" onClick={() => load()}>Retry</Button>
            </div>
          ) : !items.length ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
              <History className="h-10 w-10 opacity-20" />
              <p>No activity in this range.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40">
                  <tr>
                    {["When", "Who", "Action", "From number", "Lead"].map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((a) => (
                    <tr
                      key={a.id}
                      // Rows with a lead click through to it — same ?lead=
                      // deep link the notification bell uses. Rows without
                      // one (e.g. bulk email, guest-only actions) stay inert.
                      onClick={a.enquiryId ? () => router.push(`/leads?lead=${a.enquiryId}`) : undefined}
                      title={a.enquiryId ? "Open this lead" : undefined}
                      className={a.enquiryId ? "cursor-pointer hover:bg-brand-50/60" : "hover:bg-muted/20"}
                    >
                      <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                        {formatIST(a.createdAt, { dateStyle: "short", timeStyle: "short" })}
                      </td>
                      <td className="px-3 py-2.5 text-xs font-medium">
                        <span className="flex items-center gap-1.5">
                          {a.actorName}
                          {/* A received voice note is the one guest action in
                              this log — the name is their WhatsApp display
                              name, not a member of staff. */}
                          {a.byGuest && (
                            <span className="rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                              Guest
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        <span className="flex items-center gap-1.5">
                          {a.voiceNote && (
                            <Mic className="h-3.5 w-3.5 shrink-0 text-brand-600" aria-label="Voice note" />
                          )}
                          {a.actionLabel}
                        </span>
                        {/* What was actually said, once the background pass
                            has transcribed it — otherwise why it hasn't. */}
                        {a.voiceNote?.transcript && (
                          <span className="mt-0.5 block max-w-xl text-xs text-muted-foreground">
                            “{a.voiceNote.transcript}”
                          </span>
                        )}
                        {a.voiceNote && !a.voiceNote.transcript && a.voiceNote.status && (
                          <span className="mt-0.5 block text-xs italic text-muted-foreground">
                            {a.voiceNote.status}
                          </span>
                        )}
                        {/* The picture or the voice note itself. A row that
                            says "Message received" and nothing else is a row
                            nobody can act on — the point of opening this log
                            is to see what was actually sent. */}
                        {a.attachment && <ActivityAttachment attachment={a.attachment} />}
                      </td>
                      <td className="px-3 py-2.5 text-xs whitespace-nowrap tabular-nums text-muted-foreground">
                        {/* For a received voice note the guest is the sender —
                            this is the line it arrived on, so say that. */}
                        {a.fromNumber ? (
                          a.byGuest ? (
                            <span title="Received on this line">to {a.fromNumber}</span>
                          ) : (
                            a.fromNumber
                          )
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={`px-3 py-2.5 text-xs ${a.enquiryId ? "font-medium text-brand-700 underline-offset-2 hover:underline" : "text-muted-foreground"}`}>
                        {a.guestName ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {error && items.length > 0 && (
            <div className="border-t border-border px-3 py-2 text-center text-xs text-destructive">
              {error}
            </div>
          )}

          {nextCursor && (
            <div className="border-t border-border p-3 text-center">
              <Button size="sm" variant="ghost" onClick={() => load(nextCursor)} disabled={loading}>
                {loading ? "Loading…" : "Load older"}
              </Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
