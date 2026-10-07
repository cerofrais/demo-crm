"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Trash2, Search, Loader2, ChevronRight, Mail, MessageCircle, Phone,
  StickyNote, ListTodo, FolderOpen, History, Paperclip, RefreshCw, X,
} from "lucide-react";
import { Card, Input, Button, Badge, Dialog, Select, ScrollableTabs, type TabItem } from "@/components/ui";

/** Same list the leads board and Tasks filters use. */
const SOURCE_OPTIONS = [
  ["website_form", "Website"],
  ["whatsapp", "WhatsApp"],
  ["instagram", "Instagram"],
  ["facebook", "Facebook"],
  ["referral", "Referral"],
  ["walk_in", "Walk-in"],
  ["phone", "Phone"],
  ["google_sheets", "Google Sheets"],
] as const;
import { api } from "@/lib/client";
import { MessageBody } from "@/components/messaging/message-body";
import { cn, formatIST } from "@/lib/utils";
import { formatTag, sortTags } from "@/lib/lead-tags";
import { TagFilterBar } from "@/components/leads/tag-filter-bar";
import type { TagMatch } from "@/lib/tag-match";
import type { DeletedLeadDetailDTO, DeletedLeadListItemDTO } from "@/lib/deleted-leads";

function when(iso: string): string {
  return formatIST(iso, { dateStyle: "medium", timeStyle: "short" });
}

function duration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

/** Reads a stage/source enum as a human label without a lookup table — these
 *  are snake_case enum values (booking_confirmed, walk_in) and there's no
 *  existing shared formatter for them outside the kanban's own config. */
function humanize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const EMPTY = <span className="text-muted-foreground">—</span>;

function Section({ children }: { children: React.ReactNode }) {
  return <div className="space-y-2">{children}</div>;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">{value || EMPTY}</span>
    </div>
  );
}

function LeadDetail({ lead }: { lead: DeletedLeadDetailDTO }) {
  const [tab, setTab] = useState("overview");

  // Only offer a tab that actually holds something, so an admin isn't clicking
  // through empty sections to find where the history is.
  const tabs: TabItem[] = [
    { key: "overview", label: "Overview", icon: <Trash2 className="h-3.5 w-3.5" /> },
    ...(lead.activities.length
      ? [{ key: "activity", label: `Activity (${lead.activities.length})`, icon: <History className="h-3.5 w-3.5" /> }]
      : []),
    ...(lead.messages.length
      ? [{ key: "messages", label: `Messages (${lead.messages.length})`, icon: <Mail className="h-3.5 w-3.5" /> }]
      : []),
    ...(lead.calls.length
      ? [{ key: "calls", label: `Calls (${lead.calls.length})`, icon: <Phone className="h-3.5 w-3.5" /> }]
      : []),
    ...(lead.notes.length
      ? [{ key: "notes", label: `Remarks (${lead.notes.length})`, icon: <StickyNote className="h-3.5 w-3.5" /> }]
      : []),
    ...(lead.tasks.length
      ? [{ key: "tasks", label: `Tasks (${lead.tasks.length})`, icon: <ListTodo className="h-3.5 w-3.5" /> }]
      : []),
    ...(lead.documents.length
      ? [{ key: "documents", label: `Documents (${lead.documents.length})`, icon: <FolderOpen className="h-3.5 w-3.5" /> }]
      : []),
  ];

  return (
    <div className="border-t border-border bg-muted/20 p-4">
      <ScrollableTabs tabs={tabs} active={tab} onChange={setTab} className="mb-3" />

      {tab === "overview" && (
        <Section>
          <Row label="Guest" value={lead.guestName} />
          <Row label="Phone" value={lead.guestPhone} />
          <Row label="Email" value={lead.guestEmail} />
          <Row label="Stage when deleted" value={humanize(lead.stage)} />
          <Row label="Source" value={humanize(lead.source)} />
          <Row label="Campaign" value={lead.campaignLabel} />
          <Row label="Assigned to" value={lead.assignedToName} />
          <Row label="Quoted price" value={lead.quotedPriceINR ? `₹${lead.quotedPriceINR.toLocaleString("en-IN")}` : null} />
          <Row label="Proposed dates" value={lead.proposedDates} />
          <Row label="Lost reason" value={lead.lostReason} />
          <Row label="AI score" value={lead.aiScore != null ? `${lead.aiScore}/100${lead.aiScoreReason ? ` — ${lead.aiScoreReason}` : ""}` : null} />
          <Row
            label="Tags"
            value={lead.tags.length ? lead.tags.map((t) => <Badge key={t} className="mr-1 bg-secondary text-[10px]">{t}</Badge>) : null}
          />
          <Row label="Intake notes" value={lead.intakeNotes && <span className="whitespace-pre-wrap">{lead.intakeNotes}</span>} />
          <Row label="Created" value={when(lead.createdAt)} />
          <Row label="Deleted" value={when(lead.deletedAt)} />
        </Section>
      )}

      {tab === "activity" && (
        <div className="divide-y divide-border">
          {lead.activities.map((a) => (
            <div key={a.id} className="flex gap-3 py-2 text-xs">
              <span className="w-36 shrink-0 text-muted-foreground">{when(a.createdAt)}</span>
              <span className="w-40 shrink-0 font-medium">{a.actorName ?? "System"}</span>
              <span>{a.actionLabel}</span>
            </div>
          ))}
        </div>
      )}

      {tab === "messages" && (
        <div className="space-y-2">
          {lead.messages.map((m) => (
            <div key={m.id} className="rounded-md border border-border bg-background p-2.5">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                {m.channel === "whatsapp" ? (
                  <MessageCircle className="h-3 w-3 text-emerald-600" />
                ) : (
                  <Mail className="h-3 w-3 text-sky-600" />
                )}
                <Badge className={cn("text-[10px]", m.direction === "inbound" ? "bg-sky-100 text-sky-700" : "bg-secondary")}>
                  {m.direction}
                </Badge>
                <span>{when(m.createdAt)}</span>
                <span>{m.status}</span>
                {m.fromEmail && <span className="truncate">from {m.fromEmail}</span>}
                {m.toEmail && <span className="truncate">to {m.toEmail}</span>}
              </div>
              {m.subject && <p className="text-xs font-medium">{m.subject}</p>}
              <MessageBody body={m.body} className="text-xs" />
              {m.attachment && (
                <a
                  href={`/api/files/${m.attachment.id}?inline=1`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand-600 hover:underline"
                >
                  <Paperclip className="h-3 w-3" /> {m.attachment.filename}
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "calls" && (
        <div className="space-y-2">
          {lead.calls.map((c) => (
            <div key={c.id} className="rounded-md border border-border bg-background p-2.5">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <Phone className="h-3 w-3" />
                <Badge className="bg-secondary text-[10px]">{c.direction}</Badge>
                <span>{when(c.startedAt)}</span>
                <span>{duration(c.durationSec)}</span>
                <span>{c.customerPhone}</span>
                {c.repName && <span>rep: {c.repName}</span>}
                <span>{c.status}</span>
                {c.aiScore != null && <Badge className="bg-brand-100 text-[10px] text-brand-700">AI {c.aiScore}</Badge>}
              </div>
              {c.hasRecording && (
                // Streamed through the same proxy the live Calls page uses —
                // the provider URL needs auth and is never sent to the client.
                <audio controls preload="none" src={`/api/calls/${c.id}/recording`} className="my-1 h-8 w-full max-w-md" />
              )}
              {c.aiSummary && <p className="text-xs"><span className="text-muted-foreground">Summary: </span>{c.aiSummary}</p>}
              {(c.transcriptEnglish || c.transcript) && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] text-brand-600">Transcript</summary>
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {c.transcriptEnglish || c.transcript}
                  </p>
                </details>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "notes" && (
        <div className="space-y-2">
          {lead.notes.map((n) => (
            <div key={n.id} className="rounded-md border border-border bg-background p-2.5">
              <div className="mb-0.5 text-[11px] text-muted-foreground">
                {n.authorName ?? "Unknown"} · {when(n.createdAt)}
              </div>
              <p className="whitespace-pre-wrap break-words text-xs">{n.body}</p>
            </div>
          ))}
        </div>
      )}

      {tab === "tasks" && (
        <div className="divide-y divide-border">
          {lead.tasks.map((t) => (
            <div key={t.id} className="flex gap-3 py-2 text-xs">
              <Badge className="bg-secondary text-[10px]">{t.status}</Badge>
              <span className="flex-1">{t.title}</span>
              <span className="text-muted-foreground">{t.dueAt ? `due ${when(t.dueAt)}` : "no due date"}</span>
            </div>
          ))}
        </div>
      )}

      {tab === "documents" && (
        <div className="divide-y divide-border">
          {lead.documents.map((d) => (
            <a
              key={d.id}
              href={`/api/files/${d.id}?inline=1`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 py-2 text-xs hover:bg-muted/40"
            >
              <Paperclip className="h-3 w-3 text-muted-foreground" />
              <span className="flex-1 text-brand-600 hover:underline">{d.filename}</span>
              <Badge className="bg-secondary text-[10px]">{d.category}</Badge>
              <span className="text-muted-foreground">{when(d.createdAt)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Confirmation for an irreversible purge. Lists exactly what will be destroyed
 * from the lead's own counts, and requires the guest's name to be typed —
 * matching what the row shows, so it can't be dismissed by reflex the way a
 * plain "are you sure" can.
 */
function PurgeDialog({
  lead,
  onCancel,
  onPurged,
}: {
  lead: DeletedLeadListItemDTO;
  onCancel: () => void;
  onPurged: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const c = lead.counts;
  const willDestroy = [
    c.activities && `${c.activities} activity ${c.activities === 1 ? "entry" : "entries"}`,
    c.messages && `${c.messages} message${c.messages === 1 ? "" : "s"}`,
    c.calls && `${c.calls} call${c.calls === 1 ? "" : "s"}${c.recordings ? ` (${c.recordings} recorded)` : ""}`,
    c.notes && `${c.notes} remark${c.notes === 1 ? "" : "s"}`,
    c.tasks && `${c.tasks} task${c.tasks === 1 ? "" : "s"}`,
    c.documents && `${c.documents} document${c.documents === 1 ? "" : "s"}`,
  ].filter(Boolean) as string[];

  const confirmed = typed.trim().toLowerCase() === lead.guestName.trim().toLowerCase();

  async function purge() {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/api/deleted-leads/${lead.id}`);
      onPurged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't purge this lead");
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onCancel} title="Permanently delete this lead?">
      <p className="text-sm text-muted-foreground">
        This erases <strong className="text-foreground">{lead.guestName}</strong>&apos;s lead and
        everything kept with it. There is no backup and no undo.
      </p>

      <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
        <p className="text-xs font-medium text-destructive">Will be destroyed</p>
        {willDestroy.length ? (
          <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
            {willDestroy.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">The lead record itself — no history attached.</p>
        )}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        The guest record stays, along with any of their other leads. Messages tagged to this lead
        are removed from the guest&apos;s conversation.
      </p>

      <label className="mt-3 block text-xs font-medium text-foreground">
        Type <span className="font-mono text-destructive">{lead.guestName}</span> to confirm
      </label>
      <Input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={lead.guestName}
        className="mt-1 h-8 text-xs"
        autoFocus
      />

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onCancel} disabled={busy} className="w-full sm:w-auto">
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={purge}
          disabled={!confirmed || busy}
          className="w-full sm:w-auto"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Delete permanently
        </Button>
      </div>
    </Dialog>
  );
}

export function DeletedLeadsExplorer() {
  const [items, setItems] = useState<DeletedLeadListItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [source, setSource] = useState("");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [tagMatch, setTagMatch] = useState<TagMatch>("any");
  // The full tag universe across ALL deleted leads, not just the current
  // page — the list is cursor-paginated, so deriving this from `items` (the
  // way the live board derives it from its one already-loaded page) would
  // hide any tag that only appears on a lead not yet scrolled to.
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [counts, setCounts] = useState<{ matching: number; total: number } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<DeletedLeadDetailDTO | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<DeletedLeadListItemDTO | null>(null);
  const [purged, setPurged] = useState<string | null>(null);
  // ?lead=<id> deep link — the Guests directory sends a guest whose only lead
  // was deleted straight here. The lead is pinned above the list rather than
  // just expanded in it, because it may sit well past the first page (the
  // list is cursor-paginated by deletedAt) and would otherwise not render.
  const [focus, setFocus] = useState<DeletedLeadDetailDTO | null>(null);
  const [focusLoading, setFocusLoading] = useState(false);
  const [focusError, setFocusError] = useState<string | null>(null);
  const router = useRouter();

  // Read off window.location rather than useSearchParams() so this page
  // doesn't need a Suspense boundary — same reasoning as GuestSearch's ?q=.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("lead");
    if (!id) return;
    router.replace("/deleted", { scroll: false });
    setFocusLoading(true);
    api
      .get<DeletedLeadDetailDTO>(`/api/deleted-leads/${id}`)
      .then(setFocus)
      .catch((e) =>
        setFocusError(e instanceof Error ? e.message : "Couldn't open that deleted lead"),
      )
      .finally(() => setFocusLoading(false));
    // One-shot on mount: the param is stripped straight away, so a refresh or
    // a later Back doesn't re-pin the lead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetched once, not refreshed as filters change — a purge is the only thing
  // that could remove a tag from the universe, and that is rare enough that a
  // page reload is an acceptable way to pick it up.
  useEffect(() => {
    api.get<string[]>("/api/deleted-leads/tags").then(setAvailableTags).catch(() => {});
  }, []);

  const toggleTag = useCallback((tag: string) => {
    setActiveTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }, []);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (source) params.set("source", source);
      if (activeTags.length) {
        params.set("tags", activeTags.join(","));
        params.set("tagMatch", tagMatch);
      }
      if (cursor) params.set("cursor", cursor);
      try {
        const res = await api.get<{
          items: DeletedLeadListItemDTO[];
          nextCursor: string | null;
          matching: number;
          total: number;
        }>(`/api/deleted-leads?${params}`);
        setItems((prev) => (cursor ? [...prev, ...res.items] : res.items));
        setNextCursor(res.nextCursor);
        setCounts({ matching: res.matching, total: res.total });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load deleted leads");
      } finally {
        setLoading(false);
      }
    },
    [q, source, activeTags, tagMatch],
  );

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(id: string) {
    if (expanded === id) {
      setExpanded(null);
      setDetail(null);
      return;
    }
    setExpanded(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      setDetail(await api.get<DeletedLeadDetailDTO>(`/api/deleted-leads/${id}`));
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="space-y-3 p-4 md:p-6">
      {focusLoading && (
        <Card className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Opening deleted lead…
        </Card>
      )}

      {focusError && (
        <Card className="border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {focusError}
        </Card>
      )}

      {focus && (
        <Card className="overflow-hidden border-brand-300 ring-1 ring-brand-300">
          <div className="flex items-start gap-3 border-b border-border bg-brand-50/60 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">
                Opened from Guests — this lead was deleted
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">{focus.guestName}</span>
                <Badge className="bg-secondary text-[10px]">{humanize(focus.stage)}</Badge>
                <span className="text-xs text-muted-foreground">{humanize(focus.source)}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span>{focus.guestPhone ?? "no phone"}</span>
                <span>deleted {when(focus.deletedAt)}</span>
                {focus.assignedToName && <span>was with {focus.assignedToName}</span>}
              </div>
            </div>
            <button
              onClick={() => setFocus(null)}
              title="Close"
              aria-label="Close this lead"
              className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <LeadDetail lead={focus} />
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 md:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, phone or email…"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="h-8 w-40 text-xs"
        >
          <option value="">All sources</option>
          {SOURCE_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </Select>
        <Button size="sm" variant="outline" onClick={() => load()} className="h-8 gap-1 text-xs">
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
        {counts && (
          <span className="ml-auto text-xs text-muted-foreground">
            {/* Both numbers: a filtered view alone gives no sense of how much
                was excluded, and "of N" is what says whether the search
                actually narrowed anything. */}
            {counts.matching === counts.total
              ? `${counts.total} deleted lead${counts.total === 1 ? "" : "s"}`
              : `${counts.matching} of ${counts.total} deleted leads`}
          </span>
        )}
      </div>

      <TagFilterBar
        availableTags={availableTags}
        activeTags={activeTags}
        onToggle={toggleTag}
        onClear={() => setActiveTags([])}
        match={tagMatch}
        onMatchChange={setTagMatch}
      />

      {error && <Card className="border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</Card>}

      {loading && !items.length ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : !items.length ? (
        <Card className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
          <Trash2 className="h-10 w-10 opacity-20" />
          <p className="text-sm">No deleted leads{q.trim() ? " match that search" : " yet"}.</p>
        </Card>
      ) : (
        items.map((lead) => (
          <Card key={lead.id} className="overflow-hidden">
            <div className="flex items-start">
            <button
              onClick={() => toggle(lead.id)}
              className="flex flex-1 items-start gap-3 p-4 text-left hover:bg-secondary/40"
            >
              <ChevronRight
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                  expanded === lead.id && "rotate-90",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{lead.guestName}</span>
                  <Badge className="bg-secondary text-[10px]">{humanize(lead.stage)}</Badge>
                  <span className="text-xs text-muted-foreground">{humanize(lead.source)}</span>
                  {lead.campaignLabel && (
                    <Badge className="bg-brand-100 text-[10px] text-brand-700">{lead.campaignLabel}</Badge>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span>{lead.guestPhone ?? "no phone"}</span>
                  <span>deleted {when(lead.deletedAt)}</span>
                  {lead.assignedToName && <span>was with {lead.assignedToName}</span>}
                </div>
                {lead.tags.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {sortTags(lead.tags).map((t) => {
                      const f = formatTag(t);
                      return (
                        <span key={t} className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", f.className)}>
                          {f.label}
                        </span>
                      );
                    })}
                  </div>
                )}
                {/* What's actually retained — so it's obvious at a glance
                    whether opening this lead is worth it. */}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  {lead.counts.activities > 0 && <span className="inline-flex items-center gap-1"><History className="h-3 w-3" />{lead.counts.activities}</span>}
                  {lead.counts.messages > 0 && <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{lead.counts.messages}</span>}
                  {lead.counts.calls > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <Phone className="h-3 w-3" />{lead.counts.calls}
                      {lead.counts.recordings > 0 && ` (${lead.counts.recordings} rec)`}
                    </span>
                  )}
                  {lead.counts.notes > 0 && <span className="inline-flex items-center gap-1"><StickyNote className="h-3 w-3" />{lead.counts.notes}</span>}
                  {lead.counts.tasks > 0 && <span className="inline-flex items-center gap-1"><ListTodo className="h-3 w-3" />{lead.counts.tasks}</span>}
                  {lead.counts.documents > 0 && <span className="inline-flex items-center gap-1"><FolderOpen className="h-3 w-3" />{lead.counts.documents}</span>}
                </div>
              </div>
            </button>
              {/* Outside the expand button so it can't be hit while aiming to
                  open the row — a purge is irreversible. */}
              <button
                onClick={() => setPurgeTarget(lead)}
                title="Permanently delete this lead"
                aria-label={`Permanently delete ${lead.guestName}`}
                className="m-3 shrink-0 rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            {expanded === lead.id &&
              (detailLoading ? (
                <div className="flex justify-center border-t border-border py-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : detail ? (
                <LeadDetail lead={detail} />
              ) : (
                <div className="border-t border-border py-6 text-center text-xs text-destructive">
                  Couldn&apos;t load this lead&apos;s history.
                </div>
              ))}
          </Card>
        ))
      )}

      {nextCursor && (
        <div className="text-center">
          <Button size="sm" variant="ghost" onClick={() => load(nextCursor)} disabled={loading}>
            {loading ? "Loading…" : "Load older"}
          </Button>
        </div>
      )}

      {purgeTarget && (
        <PurgeDialog
          lead={purgeTarget}
          onCancel={() => setPurgeTarget(null)}
          onPurged={() => {
            const name = purgeTarget.guestName;
            // Dropped locally rather than refetching: the row is gone for good,
            // and a reload would also reset the reader's scroll position.
            setItems((prev) => prev.filter((l) => l.id !== purgeTarget.id));
            if (expanded === purgeTarget.id) {
              setExpanded(null);
              setDetail(null);
            }
            setPurgeTarget(null);
            setPurged(name);
          }}
        />
      )}

      {purged && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md bg-foreground px-4 py-2 text-xs text-background shadow-lg">
          Permanently deleted {purged}&apos;s lead.
          <button onClick={() => setPurged(null)} className="ml-3 underline">
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
