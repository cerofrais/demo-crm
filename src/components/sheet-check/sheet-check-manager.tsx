"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, Check, CheckCircle2, Copy, Download, FileSearch, Loader2, Play, Plus, Save, Trash2, XCircle,
} from "lucide-react";
import { Badge, Button, Card, Input, Textarea } from "@/components/ui";
import { api } from "@/lib/client";
import { cn, formatIST } from "@/lib/utils";

interface Settings {
  enabled: boolean;
  intervalDays: number;
  recipients: string[];
  pushMissing: boolean;
  lastTickAt: string | null;
}

interface Source {
  id: string;
  name: string;
  sheetUrl: string;
  campaignLabel: string | null;
  enabled: boolean;
  lastRowNumber: number | null;
  lastCheckedAt: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
}

interface SheetSummary {
  name: string;
  checked: number;
  missing: number;
  pushed: number;
  pushFailed: number;
  heldBack: number;
  error: string | null;
}

interface Run {
  id: string;
  trigger: string;
  dryRun: boolean;
  status: string;
  checkedCount: number;
  missingCount: number;
  pushedCount: number;
  pushFailedCount: number;
  sheetErrors: number;
  summary: SheetSummary[];
  hasCsv: boolean;
  emailedTo: string | null;
  emailError: string | null;
  error: string | null;
  startedAt: string;
}

interface Overview {
  settings: Settings;
  sources: Source[];
  runs: Run[];
  nextDueAt: string | null;
  serviceAccountEmail: string | null;
  cronSecretConfigured: boolean;
}

interface RunResult {
  runId: string;
  status: string;
  checked: number;
  missing: number;
  pushed: number;
  pushFailed: number;
  sheetErrors: number;
  sheets: SheetSummary[];
  missingLeads: { sheet: string; rowNumber: number; name: string; receivedAt: string | null; result: string }[];
  emailedTo: string | null;
  emailError: string | null;
}

const when = (iso: string | null) =>
  iso ? formatIST(iso, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

const splitEmails = (text: string) => [...new Set(text.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];

export function SheetCheckManager({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Settings form
  const [enabled, setEnabled] = useState(true);
  const [intervalDays, setIntervalDays] = useState("3");
  const [recipientsText, setRecipientsText] = useState("");
  const [pushMissing, setPushMissing] = useState(true);

  // Add-sheet form
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [campaign, setCampaign] = useState("");

  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [result, setResult] = useState<RunResult | null>(null);

  const load = useCallback(async () => {
    const d = await api.get<Overview>("/api/sheet-check");
    setData(d);
    setEnabled(d.settings.enabled);
    setIntervalDays(String(d.settings.intervalDays));
    setRecipientsText(d.settings.recipients.join("\n"));
    setPushMissing(d.settings.pushMissing);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "Couldn't load"));
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function act<T>(key: string, fn: () => Promise<T>, done?: string): Promise<T | undefined> {
    setBusy(key);
    setError(null);
    try {
      const out = await fn();
      if (done) setToast(done);
      return out;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  const saveSettings = () =>
    act("settings", async () => {
      await api.put("/api/sheet-check/settings", {
        enabled,
        intervalDays: Number(intervalDays),
        recipients: splitEmails(recipientsText),
        pushMissing,
      });
      await load();
    }, "Settings saved");

  const addSheet = () =>
    act("add", async () => {
      await api.post("/api/sheet-check/sources", { sheetUrl: url, name: name || null, campaignLabel: campaign || null });
      setUrl("");
      setName("");
      setCampaign("");
      await load();
    }, "Sheet added");

  const toggleSource = (s: Source) =>
    act(`toggle-${s.id}`, async () => {
      await api.patch(`/api/sheet-check/sources/${s.id}`, { enabled: !s.enabled });
      await load();
    });

  const removeSource = (s: Source) => {
    if (!window.confirm(`Stop checking "${s.name}"?`)) return;
    return act(`remove-${s.id}`, async () => {
      await api.delete(`/api/sheet-check/sources/${s.id}`);
      await load();
    });
  };

  const testSheet = async (s: Source) => {
    setBusy(`test-${s.id}`);
    try {
      const r = await api.post<{
        tabTitle: string; rows: number; leads: number; headerRow: number | null;
        lastLead: { rowNumber: number; createdTime: string | null } | null;
      }>(`/api/sheet-check/sources/${s.id}/test`, {});
      setTests((t) => ({
        ...t,
        [s.id]: {
          ok: true,
          text:
            `Readable — tab "${r.tabTitle}", ${r.leads} leads in ${r.rows} rows` +
            (r.headerRow ? `, header on row ${r.headerRow}` : ", no header row found") +
            (r.lastLead ? `. Last lead: row ${r.lastLead.rowNumber}${r.lastLead.createdTime ? `, ${when(r.lastLead.createdTime)}` : ""}` : ""),
        },
      }));
    } catch (e) {
      setTests((t) => ({ ...t, [s.id]: { ok: false, text: e instanceof Error ? e.message : "Couldn't read the sheet" } }));
    } finally {
      setBusy(null);
    }
  };

  const run = async (dryRun: boolean) => {
    if (
      !dryRun &&
      !window.confirm(
        "Run the full check now? Missing leads will be added to the CRM" +
          (data?.settings.pushMissing ? "" : " (adding is currently off, so they'll only be reported)") +
          ` and a CSV emailed to ${data?.settings.recipients.join(", ") || "nobody (no recipients set)"}.`,
      )
    ) return;
    const r = await act(dryRun ? "dry" : "run", () => api.post<RunResult>("/api/sheet-check/run", { dryRun }));
    if (r) {
      setResult(r);
      await load();
    }
  };

  if (!data) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        {error ? <span className="text-destructive">{error}</span> : <><Loader2 className="h-4 w-4 animate-spin" /> Loading…</>}
      </div>
    );
  }

  const recipients = splitEmails(recipientsText);
  const dirty =
    data.settings.enabled !== enabled ||
    String(data.settings.intervalDays) !== intervalDays ||
    data.settings.recipients.join(",") !== recipients.join(",") ||
    data.settings.pushMissing !== pushMissing;
  const tickStale = !data.settings.lastTickAt || Date.now() - new Date(data.settings.lastTickAt).getTime() > 36 * 3_600_000;

  return (
    <div className="space-y-4 p-4 md:p-6">
      {error && (
        <Card className="flex items-start gap-2 border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </Card>
      )}
      {toast && (
        <Card className="flex items-center gap-2 border-brand-200 bg-brand-50 p-3 text-sm text-brand-800">
          <Check className="h-4 w-4" /> {toast}
        </Card>
      )}

      {/* ---------------- Setup status ---------------- */}
      <Card className="space-y-2 p-4 text-sm">
        <SetupLine
          ok={!!data.serviceAccountEmail}
          label="Google access"
          text={
            data.serviceAccountEmail ? (
              <>
                Share each sheet with{" "}
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(data.serviceAccountEmail!).then(() => setToast("Address copied"))}
                  className="inline-flex items-center gap-1 font-mono text-xs text-brand-700 hover:underline"
                  title="Copy"
                >
                  {data.serviceAccountEmail} <Copy className="h-3 w-3" />
                </button>{" "}
                as a <b>Viewer</b>.
              </>
            ) : (
              "Not set up — GOOGLE_SERVICE_ACCOUNT_JSON needs adding on the server before any sheet can be read."
            )
          }
        />
        <SetupLine
          ok={data.cronSecretConfigured && !tickStale}
          label="Scheduler"
          text={
            !data.cronSecretConfigured
              ? "Not set up — SHEET_CHECK_CRON_SECRET is missing on the server, so the cron container can't call in."
              : data.settings.lastTickAt
                ? `Cron container last called in ${when(data.settings.lastTickAt)}${tickStale ? " — over a day ago, check the sheet-check-cron container" : ""}.`
                : "The cron container hasn't called in yet. It calls once a day at 9:00 AM IST."
          }
        />
        <p className="pl-6 text-xs text-muted-foreground">
          {data.settings.enabled
            ? data.nextDueAt
              ? `Next automatic check: the first daily call after ${when(data.nextDueAt)}.`
              : "Next automatic check: at the next daily call (no check has run yet)."
            : "Automatic checks are off."}
        </p>
      </Card>

      {/* ---------------- Settings ---------------- */}
      <Card className="space-y-4 p-4">
        <h2 className="text-sm font-semibold text-foreground">Settings</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <label className={cn("flex items-center gap-2 text-sm", !canManage && "opacity-60")}>
              <input
                type="checkbox"
                checked={enabled}
                disabled={!canManage}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-input accent-brand-600"
              />
              Check automatically every
              <Input
                type="number"
                min={1}
                max={30}
                value={intervalDays}
                disabled={!canManage}
                onChange={(e) => setIntervalDays(e.target.value)}
                className="h-8 w-16 text-sm"
              />
              days
            </label>
            <label className={cn("flex items-start gap-2 text-sm", !canManage && "opacity-60")}>
              <input
                type="checkbox"
                checked={pushMissing}
                disabled={!canManage}
                onChange={(e) => setPushMissing(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-input accent-brand-600"
              />
              <span>
                Add missing leads to the CRM
                <span className="block text-xs text-muted-foreground">
                  Created exactly as the n8n workflow would have, with the same duplicate protection.
                </span>
              </span>
            </label>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Email the missing-leads CSV to
            </label>
            <Textarea
              value={recipientsText}
              onChange={(e) => setRecipientsText(e.target.value)}
              disabled={!canManage}
              rows={2}
              className="text-sm"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Only sent when leads were missing or a sheet couldn&apos;t be read.
            </p>
          </div>
        </div>
        {canManage && (
          <div className="flex items-center gap-3 border-t border-border pt-3">
            <Button size="sm" onClick={saveSettings} disabled={!dirty || busy === "settings"}>
              {busy === "settings" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </Button>
            {dirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
          </div>
        )}
      </Card>

      {/* ---------------- Sheets ---------------- */}
      <Card className="overflow-hidden">
        <div className="p-4 pb-2">
          <h2 className="text-sm font-semibold text-foreground">Sheets</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Each check looks at the last 10 leads in every sheet, plus every lead added since the previous check.
            Leads under an hour old are left for the next check, since n8n may not have sent them yet.
          </p>
        </div>

        {data.sources.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">No sheets yet — add one below.</p>
        ) : (
          <div className="divide-y divide-border border-t border-border">
            {data.sources.map((s) => (
              <div key={s.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={s.sheetUrl} target="_blank" rel="noreferrer" className="text-sm font-medium text-brand-700 hover:underline">
                      {s.name}
                    </a>
                    {!s.enabled && <Badge className="bg-secondary text-muted-foreground">Off</Badge>}
                    {s.campaignLabel && <Badge className="bg-indigo-50 text-indigo-800">{s.campaignLabel}</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {s.lastCheckedAt ? `Last checked ${when(s.lastCheckedAt)}` : "Not checked yet"}
                    {s.lastMessage && (
                      <span className={cn(s.lastStatus === "error" ? "text-destructive" : s.lastStatus === "missing" ? "text-amber-700" : "")}>
                        {" — "}{s.lastMessage}
                      </span>
                    )}
                  </p>
                  {tests[s.id] && (
                    <p className={cn("mt-1 text-xs", tests[s.id].ok ? "text-brand-700" : "text-destructive")}>{tests[s.id].text}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => testSheet(s)} disabled={busy === `test-${s.id}`}>
                    {busy === `test-${s.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSearch className="h-3.5 w-3.5" />}
                    Test access
                  </Button>
                  {canManage && (
                    <>
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">
                        <input type="checkbox" checked={s.enabled} onChange={() => toggleSource(s)} className="h-3.5 w-3.5 accent-brand-600" />
                        On
                      </label>
                      <Button size="sm" variant="ghost" onClick={() => removeSource(s)} title="Remove">
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {canManage && (
          <div className="grid gap-2 border-t border-border bg-muted/20 p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Full Google Sheets link, including #gid= for the tab" className="h-9 text-sm" />
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className="h-9 text-sm" />
            <Input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="Campaign label (optional)" className="h-9 text-sm" />
            <Button size="sm" className="h-9" onClick={addSheet} disabled={!url.trim() || busy === "add"}>
              {busy === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Add sheet
            </Button>
            <p className="text-[11px] text-muted-foreground md:col-span-4">
              Leave the campaign label blank to work it out from each row&apos;s campaign name, the same way n8n does.
            </p>
          </div>
        )}
      </Card>

      {/* ---------------- Run now ---------------- */}
      {canManage && (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Run a check now</h2>
              <p className="text-xs text-muted-foreground">
                &quot;Report only&quot; changes nothing — no leads added, no email, and the next scheduled check still covers the same rows.
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => run(true)} disabled={!!busy || !data.sources.length}>
                {busy === "dry" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSearch className="h-3.5 w-3.5" />}
                Report only
              </Button>
              <Button size="sm" onClick={() => run(false)} disabled={!!busy || !data.sources.length}>
                {busy === "run" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                Full check
              </Button>
            </div>
          </div>

          {result && (
            <div className="rounded-lg border border-border p-3 text-sm">
              <p className="font-medium">
                {result.missing === 0 && result.sheetErrors === 0
                  ? `All ${result.checked} leads checked are in the CRM.`
                  : `${result.missing} of ${result.checked} checked ${result.missing === 1 ? "was" : "were"} missing` +
                    (result.pushed ? ` — ${result.pushed} added` : "") +
                    (result.pushFailed ? `, ${result.pushFailed} failed` : "") +
                    (result.sheetErrors ? `. ${result.sheetErrors} sheet${result.sheetErrors === 1 ? "" : "s"} couldn't be read.` : ".")}
                {result.emailedTo && <span className="font-normal text-muted-foreground"> Emailed to {result.emailedTo}.</span>}
                {result.emailError && <span className="font-normal text-destructive"> Email failed: {result.emailError}</span>}
              </p>
              <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                {result.sheets.map((s) => (
                  <li key={s.name}>
                    <b className="text-foreground">{s.name}</b>:{" "}
                    {s.error ? <span className="text-destructive">{s.error}</span> : `${s.checked} checked, ${s.missing} missing${s.heldBack ? `, ${s.heldBack} too new to check` : ""}`}
                  </li>
                ))}
              </ul>
              {result.missingLeads.length > 0 && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="border-b border-border text-left text-muted-foreground">
                      <tr>{["Sheet", "Row", "Name", "Received", "Result"].map((h) => <th key={h} className="py-1 pr-3 font-medium">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {result.missingLeads.map((m) => (
                        <tr key={`${m.sheet}-${m.rowNumber}`} className="border-b border-border/50">
                          <td className="py-1 pr-3">{m.sheet}</td>
                          <td className="py-1 pr-3">{m.rowNumber}</td>
                          <td className="py-1 pr-3">{m.name}</td>
                          <td className="py-1 pr-3 whitespace-nowrap">{when(m.receivedAt)}</td>
                          <td className="py-1 pr-3">{m.result}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* ---------------- History ---------------- */}
      {data.runs.length > 0 && (
        <Card className="overflow-hidden">
          <h2 className="p-4 pb-2 text-sm font-semibold text-foreground">Recent checks</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-y border-border bg-muted/40 text-left">
                <tr>
                  {["When", "How", "Result", "Checked", "Missing", "Added", "Email", ""].map((h) => (
                    <th key={h} className="px-3 py-2 font-semibold text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap px-3 py-2">{when(r.startedAt)}</td>
                    <td className="px-3 py-2">{r.trigger === "schedule" ? "Scheduled" : r.dryRun ? "Report only" : "Manual"}</td>
                    <td className="px-3 py-2">
                      {r.status === "ok" ? (
                        <span className="text-brand-700">All in CRM</span>
                      ) : r.status === "issues" ? (
                        <span className="text-amber-700">
                          {[r.missingCount && `${r.missingCount} missing`, r.sheetErrors && `${r.sheetErrors} unreadable`].filter(Boolean).join(", ")}
                        </span>
                      ) : r.status === "failed" ? (
                        <span className="text-destructive" title={r.error ?? ""}>Failed — {r.error}</span>
                      ) : (
                        <span className="text-muted-foreground">Running…</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{r.checkedCount}</td>
                    <td className="px-3 py-2">{r.missingCount}</td>
                    <td className="px-3 py-2">{r.pushedCount}{r.pushFailedCount ? ` (${r.pushFailedCount} failed)` : ""}</td>
                    <td className="px-3 py-2">
                      {r.emailedTo ? "Sent" : r.emailError ? <span className="text-destructive" title={r.emailError}>Failed</span> : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {r.hasCsv && (
                        <a href={`/api/sheet-check/runs/${r.id}/csv`} className="inline-flex items-center gap-1 text-brand-700 hover:underline">
                          <Download className="h-3 w-3" /> CSV
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function SetupLine({ ok, label, text }: { ok: boolean; label: string; text: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2">
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />}
      <span>
        <b>{label}:</b> {text}
      </span>
    </p>
  );
}
