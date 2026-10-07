"use client";

import { useEffect, useState, useCallback } from "react";
import { Phone, PhoneIncoming, PhoneOutgoing, Clock, X, Plus, Sparkles, Loader2, ChevronDown } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, Button, Input, ScoreBadge } from "@/components/ui";
import { RecordingPlayer } from "./recording-player";
import { cn, formatIST } from "@/lib/utils";
import type { CallDTO } from "@/lib/calls";

interface Props {
  guestId?: string;
  enquiryId?: string;
}

const STATUS_COLOR: Record<string, string> = {
  completed: "bg-green-100 text-green-800",
  connected: "bg-blue-100 text-blue-800",
  ringing: "bg-yellow-100 text-yellow-800",
  initiated: "bg-yellow-100 text-yellow-800",
  failed: "bg-red-100 text-red-800",
  no_answer: "bg-gray-100 text-gray-600",
  voicemail: "bg-purple-100 text-purple-800",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn("inline-block rounded px-1.5 py-0.5 text-xs font-medium", STATUS_COLOR[status] ?? "bg-gray-100 text-gray-600")}>
      {status.replace("_", " ")}
    </span>
  );
}

function DirIcon({ dir }: { dir: string }) {
  if (dir === "inbound") return <PhoneIncoming className="h-3.5 w-3.5 text-brand-500" />;
  return <PhoneOutgoing className="h-3.5 w-3.5 text-earth-400" />;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function TagEditor({ callId, initial }: { callId: string; initial: string[] }) {
  const [tags, setTags] = useState(initial);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(next: string[]) {
    setBusy(true);
    try {
      await api.patch(`/api/calls/${callId}`, { tags: next });
      setTags(next);
    } finally {
      setBusy(false);
    }
  }

  function add() {
    const v = input.trim().toLowerCase().replace(/\s+/g, "-");
    if (!v || tags.includes(v)) { setInput(""); return; }
    save([...tags, v]);
    setInput("");
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {tags.map((t) => (
        <Badge key={t} className="gap-1 bg-secondary pr-1 text-xs text-secondary-foreground">
          {t}
          <button onClick={() => save(tags.filter((x) => x !== t))} disabled={busy}>
            <X className="h-2.5 w-2.5" />
          </button>
        </Badge>
      ))}
      <div className="flex items-center gap-1">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="add tag…"
          className="h-6 w-24 px-1.5 text-xs"
        />
        <Button size="sm" variant="ghost" onClick={add} className="h-6 w-6 p-0" disabled={busy}>
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

const COACH_LABELS: Array<[keyof NonNullable<CallDTO["aiSuggestions"]>, string]> = [
  ["hookLine", "Opening"],
  ["explanation", "Explanation"],
  ["professionalism", "Professionalism"],
  ["nextSteps", "Next steps"],
];

const LANGUAGE_LABEL: Record<string, string> = {
  te: "Telugu",
  hi: "Hindi",
  mixed: "Mixed",
};

export function AiCallInsights({ call, onUpdated }: { call: CallDTO; onUpdated: (c: Partial<CallDTO>) => void }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [englishOpen, setEnglishOpen] = useState(false);
  const [nativeOpen, setNativeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analyze() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.post<Partial<CallDTO>>(`/api/calls/${call.id}/analyze`, {});
      onUpdated(updated);
      setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setBusy(false);
    }
  }

  if (!call.aiAnalyzedAt || !call.aiSummary) {
    return (
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={analyze} disabled={busy} className="h-7 gap-1 px-2 text-xs text-brand-600">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {busy ? "Analysing…" : "Analyse with AI"}
        </Button>
        {error && <span className="text-[11px] text-destructive">{error}</span>}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50/50 p-2.5">
      <div className="flex w-full items-center gap-2">
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-brand-600" />
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">{call.aiSummary}</span>
        </button>
        <ScoreBadge score={call.aiScore} />
        <button onClick={() => setOpen((o) => !o)}>
          <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open && (
        <div className="mt-2 space-y-2 border-t border-brand-200 pt-2">
          <p className="text-xs text-foreground">{call.aiSummary}</p>
          {call.aiTags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {call.aiTags.map((t) => (
                <span key={t} className="rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">{t}</span>
              ))}
            </div>
          )}
          {call.aiSuggestions && (
            <div className="space-y-1.5">
              {COACH_LABELS.map(([key, label]) =>
                call.aiSuggestions?.[key] ? (
                  <div key={key}>
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
                    <p className="text-xs text-foreground">{call.aiSuggestions[key]}</p>
                  </div>
                ) : null,
              )}
            </div>
          )}
          {!call.transcript && !call.transcriptEnglish && call.transcriptStatus && (
            <p className="text-[11px] italic text-muted-foreground">{call.transcriptStatus}</p>
          )}
          {call.transcriptEnglish && (
            <div>
              <button
                onClick={() => setEnglishOpen((o) => !o)}
                className="flex items-center gap-1 text-[11px] font-medium text-brand-600 hover:underline"
              >
                <ChevronDown className={cn("h-3 w-3 transition-transform", englishOpen && "rotate-180")} />
                {englishOpen ? "Hide" : "View"} English translation
              </button>
              {englishOpen && (
                <p className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-brand-200 bg-background p-2 text-xs text-foreground">
                  {call.transcriptEnglish}
                </p>
              )}
            </div>
          )}
          {call.transcript && (
            <div>
              <button
                onClick={() => setNativeOpen((o) => !o)}
                className="flex items-center gap-1 text-[11px] font-medium text-brand-600 hover:underline"
              >
                <ChevronDown className={cn("h-3 w-3 transition-transform", nativeOpen && "rotate-180")} />
                {nativeOpen ? "Hide" : "View"} original transcript
                {call.transcriptLanguage && ` (${LANGUAGE_LABEL[call.transcriptLanguage] ?? call.transcriptLanguage})`}
              </button>
              {nativeOpen && (
                <p className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-brand-200 bg-background p-2 text-xs text-foreground">
                  {call.transcript}
                </p>
              )}
            </div>
          )}
          <Button size="sm" variant="ghost" onClick={analyze} disabled={busy} className="h-6 gap-1 px-1.5 text-[11px] text-brand-600">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            Re-analyse
          </Button>
        </div>
      )}
    </div>
  );
}

export function CallsPanel({ guestId, enquiryId }: Props) {
  const [calls, setCalls] = useState<CallDTO[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const param = enquiryId ? `enquiryId=${enquiryId}` : `guestId=${guestId}`;
    const data = await api.get<CallDTO[]>(`/api/calls?${param}`);
    setCalls(data);
    setLoading(false);
  }, [guestId, enquiryId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Clock className="mr-2 h-4 w-4 animate-spin" />
        Loading calls…
      </div>
    );
  }

  if (!calls.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
        <Phone className="h-8 w-8 opacity-30" />
        <p className="text-sm">No calls yet for this guest.</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {calls.map((c) => (
        <div key={c.id} className="space-y-2 px-1 py-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <DirIcon dir={c.direction} />
              <div>
                <p className="text-sm font-medium">
                  {c.direction === "inbound" ? "Inbound" : "Outbound"} call
                  {c.repName && <span className="ml-1 text-muted-foreground font-normal">· {c.repName}</span>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatIST(c.startedAt, { dateStyle: "medium", timeStyle: "short" })}
                  {c.durationSec > 0 && ` · ${fmt(c.durationSec)}`}
                </p>
              </div>
            </div>
            <StatusBadge status={c.status} />
          </div>

          {c.hasRecording && (
            <RecordingPlayer callId={c.id} durationSec={c.recordingDurSec} label={c.guestName ?? c.customerPhone} />
          )}

          <AiCallInsights
            call={c}
            onUpdated={(patch) =>
              setCalls((prev) => prev.map((x) => (x.id === c.id ? { ...x, ...patch } : x)))
            }
          />

          <TagEditor callId={c.id} initial={c.tags} />
        </div>
      ))}
    </div>
  );
}
