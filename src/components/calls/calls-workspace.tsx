"use client";

import { Fragment, useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed, Filter, RefreshCw, FileText, ChevronDown, UserPlus } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Card, Badge, Button, Input, Select, ScoreBadge } from "@/components/ui";
import { RecordingPlayer } from "@/components/calls/recording-player";
import { NewLeadDialog } from "@/components/leads/new-lead-dialog";
import { TagFilterBar } from "@/components/leads/tag-filter-bar";
import { sortTags } from "@/lib/lead-tags";
import type { TagMatch } from "@/lib/tag-match";
import { api } from "@/lib/client";
import { cn, formatIST } from "@/lib/utils";
import type { CallDTO } from "@/lib/calls";
import type { EnquiryDTO } from "@/lib/types";

const STATUS_COLOR: Record<string, string> = {
  completed: "bg-green-100 text-green-800",
  connected: "bg-blue-100 text-blue-800",
  ringing: "bg-yellow-100 text-yellow-800",
  initiated: "bg-yellow-100 text-yellow-800",
  failed: "bg-red-100 text-red-800",
  no_answer: "bg-gray-100 text-gray-600",
  voicemail: "bg-purple-100 text-purple-800",
};

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** The table cell is narrow — the full sentence is the title attribute. */
function shortTranscriptStatus(status: string): string {
  if (status.startsWith("Not transcribed")) return "Not answered";
  if (status.startsWith("No recording")) return "No recording";
  if (status.startsWith("Transcribing")) return "Transcribing…";
  return "No transcript";
}

const LANGUAGE_LABEL: Record<string, string> = {
  te: "Telugu",
  hi: "Hindi",
  mixed: "Mixed",
};

/**
 * The guest's name on a call row, linking to the lead the call belongs to.
 *
 * Every call that matters leads to the same question — what is happening with
 * this person — and the answer was two screens away: read the name here, go to
 * Leads, search for it. The call already carries the enquiryId, so the name is
 * simply the link. A call with no lead behind it (an unknown number) stays
 * plain text, which is also the signal that it needs a lead created.
 */
function GuestLink({ call, className }: { call: CallDTO; className?: string }) {
  const name = call.guestName ?? "—";
  if (!call.enquiryId) return <p className={cn(className, "truncate")}>{name}</p>;
  return (
    <Link
      href={`/leads?lead=${call.enquiryId}`}
      onClick={(e) => e.stopPropagation()}
      title="Open this lead"
      className={cn(className, "block truncate text-brand-700 underline-offset-2 hover:underline")}
    >
      {name}
    </Link>
  );
}

export function CallsWorkspace({ canCreateLead }: { canCreateLead: boolean }) {
  const [tab, setTab] = useState<"all" | "unattended">("all");
  const [calls, setCalls] = useState<CallDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [direction, setDirection] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newLeadCall, setNewLeadCall] = useState<CallDTO | null>(null);
  // Lead tags — a call carries the tags of the lead it was on.
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [tagMatch, setTagMatch] = useState<TagMatch>("any");

  useEffect(() => {
    api
      .get<string[]>("/api/calls/tags")
      .then((t) => setAvailableTags(sortTags(t)))
      .catch(() => {});
  }, []);

  const load = useCallback(async (cursor?: string) => {
    setLoading(true);
    const params = new URLSearchParams();
    if (tab === "unattended") {
      params.set("unattended", "true");
    } else {
      if (direction) params.set("direction", direction);
      if (status) params.set("status", status);
      if (activeTags.length) {
        params.set("tags", activeTags.join(","));
        params.set("tagMatch", tagMatch);
      }
    }
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    if (cursor) params.set("cursor", cursor);

    const data = await api.get<{ items: CallDTO[]; nextCursor: string | null }>(`/api/calls?${params}`);
    if (cursor) {
      setCalls((prev) => [...prev, ...data.items]);
    } else {
      setCalls(data.items);
    }
    setNextCursor(data.nextCursor);
    setLoading(false);
  }, [tab, direction, status, dateFrom, dateTo, activeTags, tagMatch]);

  useEffect(() => { load(); }, [load]);

  const totalDuration = calls.reduce((s, c) => s + c.durationSec, 0);
  const withRecording = calls.filter((c) => c.hasRecording).length;

  function switchTab(next: "all" | "unattended") {
    if (next === tab) return;
    setCalls([]);
    setNextCursor(null);
    setTab(next);
  }

  return (
    <div>
      <PageHeader title="Calls" subtitle="All inbound and outbound call records with recordings." />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border px-4 md:px-6">
        <button
          onClick={() => switchTab("all")}
          className={cn(
            "flex min-h-[44px] items-center gap-1.5 border-b-2 px-3 text-sm font-medium",
            tab === "all" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <Phone className="h-4 w-4" /> All Calls
        </button>
        <button
          onClick={() => switchTab("unattended")}
          className={cn(
            "flex min-h-[44px] items-center gap-1.5 border-b-2 px-3 text-sm font-medium",
            tab === "unattended" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <PhoneMissed className="h-4 w-4" /> Missed (New Callers)
        </button>
      </div>

      {tab === "unattended" && (
        <p className="px-4 pt-3 text-xs text-muted-foreground md:px-6">
          Inbound calls from numbers with no matching lead yet, where no one picked up. A missed
          call on an existing lead shows in that lead&apos;s Activity tab instead.
        </p>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3 p-4 pb-0 md:p-6 md:pb-0">
        {[
          { label: tab === "unattended" ? "Unclaimed Callers" : "Total Calls", value: calls.length },
          { label: "Total Duration", value: fmt(totalDuration) },
          { label: "With Recordings", value: withRecording },
        ].map((s) => (
          <Card key={s.label} className="p-4">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className="text-2xl font-bold text-foreground">{s.value}</p>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2 p-4 pb-0 md:p-6 md:pb-0">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Filter className="h-3.5 w-3.5" /> Filters:
        </div>
        {tab === "all" && (
          <>
            <Select value={direction} onChange={(e) => setDirection(e.target.value)} className="w-36 lg:h-8 lg:text-xs">
              <option value="">All directions</option>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
            </Select>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36 lg:h-8 lg:text-xs">
              <option value="">All statuses</option>
              <option value="completed">Completed</option>
              <option value="no_answer">No answer</option>
              <option value="failed">Failed</option>
            </Select>
          </>
        )}
        <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-36 lg:h-8 lg:text-xs" placeholder="From" />
        <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-36 lg:h-8 lg:text-xs" placeholder="To" />
        <Button size="sm" variant="outline" onClick={() => load()} className="h-8 gap-1 text-xs">
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
      </div>

      {/* Missed calls from new callers have no lead yet, so no tags to filter by. */}
      {tab === "all" && availableTags.length > 0 && (
        <div className="mt-3">
          <TagFilterBar
            availableTags={availableTags}
            activeTags={activeTags}
            onToggle={(t) =>
              setActiveTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
            }
            onClear={() => setActiveTags([])}
            match={tagMatch}
            onMatchChange={setTagMatch}
          />
        </div>
      )}

      {/* Phone: card list */}
      <div className="space-y-2 p-4 md:hidden">
        {loading && !calls.length ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Phone className="mr-2 h-5 w-5 animate-pulse" /> Loading calls…
          </div>
        ) : !calls.length ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
            <Phone className="h-10 w-10 opacity-20" />
            <p>No calls found.</p>
          </div>
        ) : (
          calls.map((c) => (
            <Card key={c.id} className="p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  {c.direction === "inbound"
                    ? <PhoneIncoming className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
                    : <PhoneOutgoing className="mt-0.5 h-4 w-4 shrink-0 text-earth-400" />}
                  <div className="min-w-0">
                    <GuestLink call={c} className="truncate font-medium" />
                    <p className="truncate text-xs text-muted-foreground">{c.customerPhone}</p>
                  </div>
                </div>
                <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-xs font-medium", STATUS_COLOR[c.status] ?? "bg-gray-100 text-gray-600")}>
                  {c.status.replace("_", " ")}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {c.durationSec > 0 && <span>{fmt(c.durationSec)}</span>}
                <span>{formatIST(c.startedAt, { dateStyle: "short", timeStyle: "short" })}</span>
                {c.repName && <span>· {c.repName}</span>}
                <ScoreBadge score={c.aiScore} />
              </div>
              {canCreateLead && !c.guestId && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 h-8 gap-1 text-xs"
                  onClick={() => setNewLeadCall(c)}
                >
                  <UserPlus className="h-3.5 w-3.5" /> Add as lead
                </Button>
              )}
              {c.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {c.tags.map((t) => <Badge key={t} className="bg-secondary text-xs text-secondary-foreground">{t}</Badge>)}
                </div>
              )}
              {c.hasRecording && (
                <div className="mt-2">
                  <RecordingPlayer callId={c.id} durationSec={c.recordingDurSec} label={c.guestName ?? c.customerPhone} />
                </div>
              )}
              {!c.transcript && !c.transcriptEnglish && c.transcriptStatus && (
                <p className="text-xs italic text-muted-foreground">{c.transcriptStatus}</p>
              )}
              {(c.transcript || c.transcriptEnglish) && (
                <div className="mt-2">
                  <button
                    onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                    className="flex min-h-[36px] items-center gap-1 text-xs text-brand-600"
                  >
                    <FileText className="h-3.5 w-3.5" /> Transcript
                    <ChevronDown className={cn("h-3 w-3 transition-transform", expandedId === c.id && "rotate-180")} />
                  </button>
                  {expandedId === c.id && (
                    <div className="mt-2 space-y-2">
                      {c.transcriptEnglish && (
                        <div>
                          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">English translation</p>
                          <p className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-xs">{c.transcriptEnglish}</p>
                        </div>
                      )}
                      {c.transcript && (
                        <div>
                          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            Original transcript{c.transcriptLanguage && ` (${LANGUAGE_LABEL[c.transcriptLanguage] ?? c.transcriptLanguage})`}
                          </p>
                          <p className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-xs">{c.transcript}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Card>
          ))
        )}
        {nextCursor && (
          <div className="pt-1 text-center">
            <Button size="sm" variant="ghost" onClick={() => load(nextCursor)} disabled={loading}>
              {loading ? "Loading…" : "Load older"}
            </Button>
          </div>
        )}
      </div>

      {/* md+: table */}
      <div className="hidden p-6 md:block">
        <Card className="overflow-hidden">
          {loading && !calls.length ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Phone className="mr-2 h-5 w-5 animate-pulse" /> Loading calls…
            </div>
          ) : !calls.length ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
              <Phone className="h-10 w-10 opacity-20" />
              <p>No calls found.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40">
                  <tr>
                    {["Dir", "Guest / Caller", "Rep", "Duration", "Status", "AI Score", "Recording", "Tags", "Date", "Transcript", "Lead"].map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {calls.map((c) => (
                    <Fragment key={c.id}>
                      <tr className="hover:bg-muted/20">
                        <td className="px-3 py-2.5">
                          {c.direction === "inbound"
                            ? <PhoneIncoming className="h-4 w-4 text-brand-500" />
                            : <PhoneOutgoing className="h-4 w-4 text-earth-400" />}
                        </td>
                        <td className="px-3 py-2.5">
                          <GuestLink call={c} className="font-medium" />
                          <p className="text-xs text-muted-foreground">{c.customerPhone}</p>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground">{c.repName ?? "—"}</td>
                        <td className="px-3 py-2.5 text-xs">{c.durationSec > 0 ? fmt(c.durationSec) : "—"}</td>
                        <td className="px-3 py-2.5">
                          <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", STATUS_COLOR[c.status] ?? "bg-gray-100 text-gray-600")}>
                            {c.status.replace("_", " ")}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          {c.aiScore !== null ? (
                            <ScoreBadge score={c.aiScore} />
                          ) : (
                            // Not a blank cell: say why there is no transcript
                            // (most often the call was never answered).
                            <span
                              className="text-xs text-muted-foreground"
                              title={c.transcriptStatus ?? undefined}
                            >
                              {c.transcriptStatus ? shortTranscriptStatus(c.transcriptStatus) : "—"}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {c.hasRecording
                            ? <RecordingPlayer callId={c.id} durationSec={c.recordingDurSec} label={c.guestName ?? c.customerPhone} />
                            : <span className="text-xs text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {c.tags.map((t) => <Badge key={t} className="bg-secondary text-xs text-secondary-foreground">{t}</Badge>)}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                          {formatIST(c.startedAt, { dateStyle: "short", timeStyle: "short" })}
                        </td>
                        <td className="px-3 py-2.5">
                          {c.transcript || c.transcriptEnglish ? (
                            <button
                              onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                              className="flex items-center gap-1 text-xs text-brand-600 hover:underline"
                            >
                              <FileText className="h-3.5 w-3.5" />
                              <ChevronDown className={cn("h-3 w-3 transition-transform", expandedId === c.id && "rotate-180")} />
                            </button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {canCreateLead && !c.guestId ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1 text-xs"
                              onClick={() => setNewLeadCall(c)}
                            >
                              <UserPlus className="h-3.5 w-3.5" /> Add
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                      {expandedId === c.id && (c.transcript || c.transcriptEnglish) && (
                        <tr className="bg-secondary/20">
                          <td colSpan={11} className="px-3 py-3">
                            <div className="grid grid-cols-2 gap-3">
                              {c.transcriptEnglish && (
                                <div>
                                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">English translation</p>
                                  <p className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-xs text-foreground">
                                    {c.transcriptEnglish}
                                  </p>
                                </div>
                              )}
                              {c.transcript && (
                                <div>
                                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                    Original transcript
                                    {c.transcriptLanguage && ` (${LANGUAGE_LABEL[c.transcriptLanguage] ?? c.transcriptLanguage})`}
                                  </p>
                                  <p className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-xs text-foreground">
                                    {c.transcript}
                                  </p>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
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

      {canCreateLead && newLeadCall && (
        <NewLeadDialog
          initialPhone={newLeadCall.customerPhone}
          onClose={() => setNewLeadCall(null)}
          onCreated={async (enquiry: EnquiryDTO) => {
            // Link this call to the lead just created from it, so it drops
            // off the unattended queue and shows up in the new lead's own
            // call history instead of staying an orphaned missed call.
            try {
              await api.patch(`/api/calls/${newLeadCall.id}`, {
                guestId: enquiry.guest.id,
                enquiryId: enquiry.id,
              });
            } catch {
              // Non-fatal — the lead itself was created fine; the call just
              // stays unlinked and someone can connect it manually later.
            }
            setCalls((prev) => prev.filter((c) => c.id !== newLeadCall.id));
          }}
        />
      )}
    </div>
  );
}
