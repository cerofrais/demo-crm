"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Download, Mail, Loader2, RefreshCw, FileSpreadsheet, Check, AlertTriangle, Info, CalendarRange,
} from "lucide-react";
import Link from "next/link";
import { Card, Button, Badge, Input } from "@/components/ui";
import { api } from "@/lib/client";
import { cn, formatIST } from "@/lib/utils";

interface ReportRow {
  id: string;
  reportDate: string | null;
  rangeStart: string;
  rangeEnd: string;
  custom: boolean;
  filename: string;
  rowCount: number;
  sizeBytes: number;
  generatedAt: string;
  emailedAt: string | null;
  emailedTo: string | null;
  emailError: string | null;
}

interface Payload {
  ceoEmail: string;
  reports: ReportRow[];
}

/** Column definitions, shown on the page so anyone reading the CSV knows what
 *  each field means and — importantly — which ones are derived rather than
 *  captured. Mirrors REPORT_HEADERS in lib/marketing-report.ts. */
const DEFINITIONS: { column: string; meaning: string; derived?: boolean }[] = [
  { column: "Lead ID", meaning: "The lead's unique id in the CRM. Use it to find the lead in the pipeline." },
  { column: "Lead Received Date & Time", meaning: "When the lead reached the CRM, in IST." },
  { column: "Lead Name / Mobile Number / Email ID", meaning: "The guest's contact details as captured." },
  { column: "City/Location", meaning: "City on the guest record. Blank when the form didn't ask for it." },
  { column: "Form Name", meaning: "The Meta lead form the guest submitted.", derived: true },
  { column: "Form Questions & Answers", meaning: "Every question on that form and the guest's answer, one per line.", derived: true },
  { column: "Campaign Name", meaning: "The campaign label recorded against the lead." },
  { column: "Platform", meaning: "Read from the campaign naming (FBIG → Meta). Falls back to the lead source.", derived: true },
  { column: "Adset / Ad Group", meaning: "The targeting segment in the ad name, e.g. Remarket. Blank if the name doesn't carry one.", derived: true },
  { column: "Ad / Creative", meaning: "The creative in the ad name, e.g. Ad1_Video.", derived: true },
  { column: "Assigned Sales Representative", meaning: "Who the lead is assigned to, or Unassigned." },
  { column: "First / Latest Follow-up Date & Time", meaning: "Our first and most recent outbound contact — a message we sent or a call we placed.", derived: true },
  { column: "Number of Follow-up Attempts", meaning: "Count of outbound messages plus outbound calls. The guest's replies are not counted as attempts.", derived: true },
  { column: "Latest Follow-up Remark", meaning: "The most recent remark a rep wrote." },
  { column: "All Follow-up Remarks", meaning: "Every remark, newest first, each stamped with its time and author." },
  { column: "Current Lead Status", meaning: "Hot / Warm / Cold / Dead — see the rules below.", derived: true },
  { column: "Detailed Remarks", meaning: "Signals detected from the stage and the rep's wording: Consultation Booked, Price Concern, Callback Requested, and so on. More than one can apply.", derived: true },
  { column: "Next Follow-up Date", meaning: "Due date of the lead's next open task, if one is set." },
  { column: "Final Conversion Status", meaning: "Where the lead stands: Open, Consultation Booked, Visit Completed, Admission, Closed Lost." },
  { column: "Final Conversion Remarks", meaning: "The lost reason when there is one, otherwise the latest remark." },
];

const TEMPERATURE_RULES: { label: string; className: string; rule: string }[] = [
  {
    label: "Hot",
    className: "bg-rose-100 text-rose-700",
    rule: "The guest replied and the conversation is live — a reply within the last 7 days. Booked and converted leads count as Hot too.",
  },
  {
    label: "Warm",
    className: "bg-amber-100 text-amber-800",
    rule: "Has replied at some point but hasn't confirmed — asked us to call back, said they'd come later, or the thread has simply gone quiet.",
  },
  {
    label: "Cold",
    className: "bg-sky-100 text-sky-700",
    rule: "Never responded at all, or said no — not interested, price too high, dropped out. An explicit no outranks an active conversation.",
  },
  {
    label: "Dead",
    className: "bg-secondary text-secondary-foreground",
    rule: "Formally closed out as lost. Kept separate from Cold so Cold keeps meaning \"gone quiet\".",
  },
];

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The window a report covers — one date for a daily report, a range for a
 *  manually generated one. */
function describeWindow(r: ReportRow): string {
  const start = formatIST(r.rangeStart, { dateStyle: "full" });
  const end = formatIST(r.rangeEnd, { dateStyle: "full" });
  return start === end ? start : `${start} → ${end}`;
}

export function MarketingReports({ canSend }: { canSend: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showDefs, setShowDefs] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<Payload>("/api/reports/marketing"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load reports");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function generate() {
    setBusy("generate");
    setError(null);
    try {
      const res = await api.post<{ rowCount: number }>("/api/reports/marketing", {});
      setToast(`Generated yesterday's report — ${res.rowCount} lead${res.rowCount === 1 ? "" : "s"}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't generate the report");
    } finally {
      setBusy(null);
    }
  }

  async function generateRange() {
    if (!from || !to) return;
    setBusy("range");
    setError(null);
    try {
      const res = await api.post<{ rowCount: number }>("/api/reports/marketing", { from, to });
      setToast(`Generated ${from} → ${to} — ${res.rowCount} lead${res.rowCount === 1 ? "" : "s"}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't generate that range");
    } finally {
      setBusy(null);
    }
  }

  async function emailToCeo(r: ReportRow) {
    setBusy(r.id);
    setError(null);
    try {
      const res = await api.post<{ to: string }>(`/api/reports/marketing/${r.id}/email`, {});
      setToast(`Emailed ${r.filename} to ${res.to}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't email the report");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* Sub-navigation between the two report views. */}
      <div className="flex gap-1 border-b border-border">
        <Link
          href="/reports"
          className="border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          Overview
        </Link>
        <span className="border-b-2 border-brand-600 px-3 py-2 text-sm font-medium text-foreground">
          Marketing
        </span>
      </div>

      {error && <Card className="border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</Card>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Generated automatically each morning for the previous day and emailed to{" "}
          <span className="font-medium text-foreground">{data?.ceoEmail ?? "the CEO"}</span>.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={load} className="h-8 gap-1 text-xs">
            <RefreshCw className="h-3 w-3" /> Refresh
          </Button>
          {canSend && (
            <Button size="sm" onClick={generate} disabled={busy === "generate"} className="h-8 gap-1 text-xs">
              {busy === "generate" ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileSpreadsheet className="h-3 w-3" />}
              Generate yesterday&apos;s
            </Button>
          )}
        </div>
      </div>

      {canSend && (
        <Card className="flex flex-wrap items-end gap-3 p-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">From</label>
            <Input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className="h-8 w-40 text-xs"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">To</label>
            <Input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              className="h-8 w-40 text-xs"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={generateRange}
            disabled={!from || !to || busy === "range"}
            className="h-8 gap-1 text-xs"
          >
            {busy === "range" ? <Loader2 className="h-3 w-3 animate-spin" /> : <CalendarRange className="h-3 w-3" />}
            Generate for this range
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Both dates included. Pick the same day twice for a single day.
          </p>
        </Card>
      )}

      {loading && !data ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : !data?.reports.length ? (
        <Card className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
          <FileSpreadsheet className="h-10 w-10 opacity-20" />
          <p className="text-sm">No reports yet — the first one runs tomorrow morning.</p>
          {canSend && (
            <Button size="sm" variant="outline" onClick={generate} disabled={busy === "generate"}>
              Generate yesterday&apos;s now
            </Button>
          )}
        </Card>
      ) : (
        <div className="space-y-2">
          {data.reports.map((r) => (
            <Card key={r.id} className="flex flex-wrap items-center gap-3 p-3">
              <FileSpreadsheet className="h-5 w-5 shrink-0 text-emerald-600" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{r.filename}</span>
                  <Badge className="bg-secondary text-[10px]">
                    {r.rowCount} lead{r.rowCount === 1 ? "" : "s"}
                  </Badge>
                  {r.custom && (
                    <Badge className="bg-violet-100 text-[10px] text-violet-700">custom range</Badge>
                  )}
                  {r.emailedAt ? (
                    <Badge className="bg-emerald-100 text-[10px] text-emerald-700">
                      <Check className="mr-0.5 inline h-2.5 w-2.5" />
                      emailed
                    </Badge>
                  ) : r.emailError ? (
                    <Badge className="bg-destructive/10 text-[10px] text-destructive">
                      <AlertTriangle className="mr-0.5 inline h-2.5 w-2.5" />
                      send failed
                    </Badge>
                  ) : (
                    <Badge className="bg-amber-100 text-[10px] text-amber-800">not emailed</Badge>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {describeWindow(r)} · {fileSize(r.sizeBytes)} · generated{" "}
                  {formatIST(r.generatedAt, { dateStyle: "medium", timeStyle: "short" })}
                  {r.emailedAt && r.emailedTo
                    ? ` · sent to ${r.emailedTo} on ${formatIST(r.emailedAt, { dateStyle: "medium", timeStyle: "short" })}`
                    : ""}
                </p>
                {r.emailError && !r.emailedAt && (
                  <p className="mt-0.5 text-xs text-destructive">{r.emailError}</p>
                )}
              </div>

              <div className="flex shrink-0 gap-2">
                <a href={`/api/reports/marketing/${r.id}/download`} download>
                  <Button size="sm" variant="outline" className="h-8 gap-1 text-xs">
                    <Download className="h-3 w-3" /> Download
                  </Button>
                </a>
                {canSend && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => emailToCeo(r)}
                    disabled={busy === r.id}
                    className="h-8 gap-1 text-xs"
                    title={`Email to ${data.ceoEmail}`}
                  >
                    {busy === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Mail className="h-3 w-3" />}
                    Email to CEO
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ── Definitions ─────────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <button
          onClick={() => setShowDefs((v) => !v)}
          className="flex w-full items-center gap-2 p-4 text-left hover:bg-secondary/40"
        >
          <Info className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">What&apos;s in the report</span>
          <span className="ml-auto text-xs text-muted-foreground">{showDefs ? "Hide" : "Show"}</span>
        </button>

        {showDefs && (
          <div className="border-t border-border p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Lead status
            </h3>
            <div className="mb-5 space-y-1.5">
              {TEMPERATURE_RULES.map((t) => (
                <div key={t.label} className="flex gap-2 text-xs">
                  <Badge className={cn("h-fit shrink-0 text-[10px]", t.className)}>{t.label}</Badge>
                  <span className="text-muted-foreground">{t.rule}</span>
                </div>
              ))}
            </div>

            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Columns
            </h3>
            <div className="space-y-1.5">
              {DEFINITIONS.map((d) => (
                <div key={d.column} className="flex flex-col gap-0.5 text-xs sm:flex-row sm:gap-3">
                  <span className="shrink-0 font-medium sm:w-64">{d.column}</span>
                  <span className="text-muted-foreground">
                    {d.meaning}
                    {d.derived && (
                      <span className="ml-1 text-[10px] uppercase tracking-wide text-amber-700">derived</span>
                    )}
                  </span>
                </div>
              ))}
            </div>

            <p className="mt-4 rounded-md bg-secondary/60 p-2.5 text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">Derived</span> means the value is worked
              out from other data rather than captured as its own field. Platform, ad set and
              creative are read from the campaign and ad naming convention, so they go blank if a
              campaign is named differently — Meta&apos;s own ad set ids aren&apos;t sent to the CRM
              today. Lead status and detailed remarks are rules applied to the follow-up history,
              not something a rep sets by hand.
            </p>
          </div>
        )}
      </Card>

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md bg-foreground px-4 py-2 text-xs text-background shadow-lg">
          {toast}
          <button onClick={() => setToast(null)} className="ml-3 underline">
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
