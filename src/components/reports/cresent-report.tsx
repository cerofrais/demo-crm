"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Download, FileAudio, Loader2, Mail, Save } from "lucide-react";
import { Badge, Button, Card, Input, Select, Textarea } from "@/components/ui";
import { TagFilterBar } from "@/components/leads/tag-filter-bar";
import { formatTag, sortTags } from "@/lib/lead-tags";
import { stageLabel } from "@/lib/kanban";
import { api } from "@/lib/client";
import { cn, formatIST } from "@/lib/utils";
import {
  addDays,
  addWeeks,
  ADMIN_COMMENTS_COLUMN,
  adminCommentsCell,
  MAX_RANGE_DAYS,
  rangeDays,
  contactTimeLabel,
  CREATED_AT_COLUMN,
  CSV_HEADERS,
  dayLabel,
  FINAL_STAGE_COLUMN,
  istWeekStart,
  reportRecordings,
  TOUCH_HEADERS,
  touchCells,
  USER_DETAIL_COLUMNS,
  type CresentReportDTO,
} from "@/lib/cresent-report-shape";
import { ReportsTabs } from "./reports-tabs";

interface Settings {
  enabled: boolean;
  recipients: string[];
  tags: string[];
  updatedAt: string | null;
}

interface SendRow {
  id: string;
  weekStart: string;
  rangeEnd: string;
  scheduled: boolean;
  tags: string[];
  rowCount: number;
  emailedAt: string | null;
  emailedTo: string | null;
  emailError: string | null;
  createdAt: string;
}

/** "7 Sep 2026 – 13 Sep 2026", or a single day when both ends match. */
function rangeLabel(start: string, end: string): string {
  const f = (d: string) =>
    new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${d}T00:00:00.000Z`),
    );
  return start === end ? f(start) : `${f(start)} – ${f(end)}`;
}


const splitEmails = (text: string) =>
  [...new Set(text.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];

export function CresentReport({ canEdit }: { canEdit: boolean }) {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [sends, setSends] = useState<SendRow[]>([]);
  const [sendHour, setSendHour] = useState(9);
  const [availableTags, setAvailableTags] = useState<string[]>([]);

  // The form — edits stay local until Save.
  const [enabled, setEnabled] = useState(false);
  const [recipientsText, setRecipientsText] = useState("");
  const [tags, setTags] = useState<string[]>([]);

  const weeks = useMemo(() => {
    const last = addWeeks(istWeekStart(new Date()), -1);
    // The week in progress too, for a look before Monday — flagged as partial.
    return [addWeeks(last, 1), ...Array.from({ length: 12 }, (_, i) => addWeeks(last, -i))];
  }, []);
  // Weekly: pick a Monday–Sunday week. Custom: pick any From/To dates.
  const [mode, setMode] = useState<"weekly" | "custom">("weekly");
  const [week, setWeek] = useState(() => weeks[1]);
  const [customFrom, setCustomFrom] = useState(() => weeks[1]);
  const [customTo, setCustomTo] = useState(() => addDays(weeks[1], 6));
  const range = useMemo(() => {
    if (mode === "weekly") return { start: week, end: addDays(week, 6) };
    if (!customFrom || !customTo || customFrom > customTo) return null;
    return { start: customFrom, end: customTo };
  }, [mode, week, customFrom, customTo]);
  const rangeTooLong = !!range && rangeDays(range.start, range.end) > MAX_RANGE_DAYS;

  const [report, setReport] = useState<CresentReportDTO | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [busy, setBusy] = useState<"save" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    const res = await api.get<{ settings: Settings; sends: SendRow[]; sendHourIst: number }>("/api/reports/cresent/settings");
    setSaved(res.settings);
    setSends(res.sends);
    setSendHour(res.sendHourIst);
    setEnabled(res.settings.enabled);
    setRecipientsText(res.settings.recipients.join("\n"));
    setTags(res.settings.tags);
  }, []);

  useEffect(() => {
    loadSettings().catch((e) => setError(e instanceof Error ? e.message : "Couldn't load the settings"));
    api.get<string[]>("/api/enquiries/tags").then((t) => setAvailableTags(sortTags(t))).catch(() => {});
  }, [loadSettings]);

  // Preview follows the tags on screen, saved or not, so a selection can be
  // checked before it is saved.
  useEffect(() => {
    if (!saved || !range || rangeTooLong) return;
    let cancelled = false;
    setLoadingReport(true);
    const params = new URLSearchParams({ from: range.start, to: range.end, tags: tags.join(",") });
    api
      .get<CresentReportDTO>(`/api/reports/cresent?${params}`)
      .then((r) => { if (!cancelled) setReport(r); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't build the report"); })
      .finally(() => { if (!cancelled) setLoadingReport(false); });
    return () => { cancelled = true; };
  }, [range, rangeTooLong, tags, saved]);

  const recipients = splitEmails(recipientsText);
  const dirty =
    !!saved &&
    (saved.enabled !== enabled ||
      saved.recipients.join(",") !== recipients.join(",") ||
      [...saved.tags].sort().join(",") !== [...tags].sort().join(","));

  async function save() {
    setBusy("save");
    setError(null);
    try {
      await api.put("/api/reports/cresent/settings", { enabled, recipients, tags });
      await loadSettings();
      setToast("Saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(null);
    }
  }

  async function sendNow() {
    if (!saved || !range) return;
    if (!window.confirm(`Email the report for ${rangeLabel(range.start, range.end)} to ${saved.recipients.join(", ")}?`)) return;
    setBusy("send");
    setError(null);
    try {
      const res = await api.post<{ rowCount: number; to: string }>("/api/reports/cresent/send", { from: range.start, to: range.end });
      setToast(`Sent ${res.rowCount} lead${res.rowCount === 1 ? "" : "s"} to ${res.to}`);
      await loadSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the report");
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const csvHref = range
    ? `/api/reports/cresent?${new URLSearchParams({ from: range.start, to: range.end, tags: tags.join(","), format: "csv" })}`
    : null;
  // Same range and tags as the CSV, so the zip holds exactly the recordings
  // the CSV's Call Recording columns point at — with that CSV at its root.
  const audioHref = range
    ? `/api/reports/cresent/audio?${new URLSearchParams({ from: range.start, to: range.end, tags: tags.join(",") })}`
    : null;
  const recordingCount = useMemo(() => (report ? reportRecordings(report).length : 0), [report]);
  const tagLabel = (t: string) => formatTag(t).label;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <ReportsTabs active="cresent" />

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

      {/* ---------------- Settings ---------------- */}
      <Card className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Weekly email</h2>
            <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
              Every Monday at {sendHour}:00 IST, the report for the previous Monday–Sunday is emailed
              to the addresses below. It lists leads received that week that carry <b>any</b> of the
              selected tags.
            </p>
          </div>
          <label className={cn("flex items-center gap-2 text-sm", !canEdit && "opacity-60")}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={!canEdit}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-input accent-brand-600"
            />
            Send every Monday
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Send to
            </label>
            <Textarea
              value={recipientsText}
              onChange={(e) => setRecipientsText(e.target.value)}
              disabled={!canEdit}
              rows={3}
              placeholder={"name@example.com\none address per line"}
              className="text-sm"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">One address per line, or separated by commas.</p>
          </div>

          <div className="min-w-0">
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Tags — a lead with any one of these is included
            </label>
            {!canEdit && (
              <p className="mb-1 text-[11px] text-muted-foreground">
                Change the tags to filter the report below. Only an admin can save them for the weekly email.
              </p>
            )}
            <div className="mb-2 flex min-h-[2rem] flex-wrap items-center gap-1">
              {tags.length === 0 ? (
                <span className="text-xs text-muted-foreground">No tags selected — the report will be empty.</span>
              ) : (
                tags.map((t) => (
                  <Badge key={t} className={cn("gap-1", formatTag(t).className)}>
                    {tagLabel(t)}
                    <button
                      type="button"
                      onClick={() => setTags((prev) => prev.filter((x) => x !== t))}
                      aria-label={`Remove ${tagLabel(t)}`}
                      className="opacity-70 hover:opacity-100"
                    >
                      ×
                    </button>
                  </Badge>
                ))
              )}
            </div>
            {availableTags.length > 0 && (
              <div className="-mx-4">
                <TagFilterBar
                  availableTags={availableTags}
                  activeTags={tags}
                  onToggle={(t) => setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))}
                  onClear={() => setTags([])}
                />
              </div>
            )}
          </div>
        </div>

        {canEdit && (
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <Button size="sm" onClick={save} disabled={!dirty || busy === "save"}>
              {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </Button>
            {dirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
            {!dirty && saved?.enabled && (
              <span className="text-xs text-muted-foreground">
                On — next email Monday {sendHour}:00 IST to {saved.recipients.join(", ")}
              </span>
            )}
          </div>
        )}
      </Card>

      {/* ---------------- Preview ---------------- */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Report</h2>
            <div className="flex rounded-md border border-input p-0.5" role="group" aria-label="Report period">
              {([["weekly", "Weekly"], ["custom", "Custom dates"]] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMode(key)}
                  aria-pressed={mode === key}
                  className={cn(
                    "rounded px-2.5 py-1 text-xs font-medium",
                    mode === key ? "bg-brand-600 text-white" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === "weekly" && (
              <Select value={week} onChange={(e) => setWeek(e.target.value)} className="h-8 w-64 text-xs" aria-label="Week">
                {weeks.map((w, i) => (
                  <option key={w} value={w}>
                    {rangeLabel(w, addDays(w, 6))}
                    {i === 0 ? " (this week, so far)" : ""}
                  </option>
                ))}
              </Select>
            )}
            {mode === "custom" && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                From
                <Input
                  type="date"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  aria-label="From"
                  className="h-8 w-[9.5rem] text-xs"
                />
                to
                <Input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(e) => setCustomTo(e.target.value)}
                  aria-label="To"
                  className="h-8 w-[9.5rem] text-xs"
                />
              </span>
            )}
            {mode === "custom" && !range && (
              <span className="text-xs text-destructive">Pick a from date on or before the to date</span>
            )}
            {rangeTooLong && (
              <span className="text-xs text-destructive">Pick {MAX_RANGE_DAYS} days or fewer</span>
            )}
            {loadingReport ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              report && <span className="text-xs text-muted-foreground">{report.leadCount} leads</span>
            )}
          </div>
          <div className="flex gap-2">
            <a
              href={csvHref ?? undefined}
              aria-disabled={!csvHref || rangeTooLong}
              className={cn(
                "inline-flex h-8 items-center gap-1 rounded-md border border-input px-3 text-xs font-medium hover:bg-muted",
                (!csvHref || rangeTooLong) && "pointer-events-none opacity-50",
              )}
            >
              <Download className="h-3.5 w-3.5" /> CSV
            </a>
            <a
              href={audioHref ?? undefined}
              aria-disabled={!audioHref || rangeTooLong || recordingCount === 0}
              title={
                recordingCount
                  ? "A zip of every call recording in this report, as campaign / lead / file, with the CSV inside"
                  : "No recorded calls in this report"
              }
              className={cn(
                "inline-flex h-8 items-center gap-1 rounded-md border border-input px-3 text-xs font-medium hover:bg-muted",
                (!audioHref || rangeTooLong || recordingCount === 0) && "pointer-events-none opacity-50",
              )}
            >
              <FileAudio className="h-3.5 w-3.5" /> Download audios
              {recordingCount > 0 && <span className="text-muted-foreground">({recordingCount})</span>}
            </a>
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                onClick={sendNow}
                disabled={busy === "send" || dirty || !range || rangeTooLong || !saved?.recipients.length || !saved?.tags.length}
                title={dirty ? "Save your changes first — the email uses the saved recipients and tags" : undefined}
                className="h-8 text-xs"
              >
                {busy === "send" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
                Email this report now
              </Button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto border-t border-border">
          <table className="min-w-max border-collapse text-xs">
            <thead>
              <tr>
                {["Date", "Number of Leads Received", "Tags"].map((h) => (
                  <th key={h} rowSpan={2} className="border border-neutral-600 bg-neutral-900 px-2 py-1.5 font-semibold text-white">
                    {h}
                  </th>
                ))}
                <th colSpan={USER_DETAIL_COLUMNS.length} className="border border-neutral-600 bg-neutral-900 px-2 py-1.5 font-semibold text-white">
                  User Necessary Details (Name / phone no. / email ID etc)
                </th>
                {[CREATED_AT_COLUMN, ...TOUCH_HEADERS, FINAL_STAGE_COLUMN, ADMIN_COMMENTS_COLUMN].map((h) => (
                  <th key={h} rowSpan={2} className="border border-neutral-600 bg-neutral-900 px-2 py-1.5 font-semibold text-white">
                    {h}
                  </th>
                ))}
              </tr>
              <tr>
                {USER_DETAIL_COLUMNS.map((c) => (
                  <th key={c} className="border border-neutral-600 bg-neutral-900 px-2 py-1 font-semibold text-white">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report && report.leadCount === 0 && !loadingReport && (
                <tr>
                  <td colSpan={CSV_HEADERS.length} className="border border-border px-3 py-8 text-center text-muted-foreground">
                    {tags.length ? "No leads with these tags in this period." : "Select at least one tag to build the report."}
                  </td>
                </tr>
              )}
              {report?.days.flatMap((d) =>
                d.leads.map((lead, i) => (
                  <tr key={lead.enquiryId} className="align-top">
                    {i === 0 && (
                      <>
                        <td rowSpan={d.leads.length} className="whitespace-nowrap border border-border px-2 py-1.5 text-center">
                          {dayLabel(d.day)}
                        </td>
                        <td rowSpan={d.leads.length} className="border border-border px-2 py-1.5 text-center">
                          {d.leads.length}
                        </td>
                      </>
                    )}
                    <td className="border border-border px-2 py-1.5">{lead.tags.map(tagLabel).join(", ")}</td>
                    <td className="border border-border px-2 py-1.5">
                      <a href={`/leads?lead=${lead.enquiryId}`} className="text-brand-700 hover:underline">
                        {lead.name}
                      </a>
                    </td>
                    <td className="whitespace-nowrap border border-border px-2 py-1.5">{lead.phone}</td>
                    <td className="border border-border px-2 py-1.5">{lead.email}</td>
                    <td className="border border-border px-2 py-1.5">{lead.city}</td>
                    <td className="whitespace-nowrap border border-border px-2 py-1.5">{contactTimeLabel(lead.receivedAt)}</td>
                    <FragmentCells cells={touchCells(lead)} />
                    <td className="whitespace-nowrap border border-border px-2 py-1.5">{stageLabel(lead.stage)}</td>
                    {/* Admin remarks, kept apart from the reps' remarks above. */}
                    <td className="max-w-xs whitespace-pre-wrap border border-border bg-indigo-50/60 px-2 py-1.5">
                      {adminCommentsCell(lead)}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-muted-foreground">
        <b>How contacts are read:</b> every call on the lead, and every WhatsApp or email a person sent
        (from the CRM or the WhatsApp phone app) — auto-replies, welcome emails and broadcasts are not
        follow-ups. Calls or messages on the same channel within an hour count as one contact. Remarks
        are the notes a rep wrote after that contact and before the next one; blank when there are none.
      </p>

      {/* ---------------- Send log ---------------- */}
      {sends.length > 0 && (
        <Card className="overflow-hidden">
          <h2 className="p-4 pb-2 text-sm font-semibold text-foreground">Sent</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-y border-border bg-muted/40">
                <tr>
                  {["Week", "How", "Leads", "To", "Status"].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-semibold text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sends.map((s) => (
                  <tr key={s.id}>
                    <td className="whitespace-nowrap px-3 py-2">{rangeLabel(s.weekStart, s.rangeEnd)}</td>
                    <td className="px-3 py-2">{s.scheduled ? "Monday schedule" : "Sent by hand"}</td>
                    <td className="px-3 py-2">{s.rowCount}</td>
                    <td className="px-3 py-2">{s.emailedTo ?? "—"}</td>
                    <td className="px-3 py-2">
                      {s.emailedAt ? (
                        <span className="text-brand-700">
                          Sent {formatIST(s.emailedAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                        </span>
                      ) : s.emailError ? (
                        <span className="text-destructive" title={s.emailError}>Failed — {s.emailError}</span>
                      ) : (
                        <span className="text-muted-foreground">Pending</span>
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

/** A contact's Date / Remarks / Status cells, repeated per contact. */
function FragmentCells({ cells }: { cells: string[] }) {
  return (
    <>
      {cells.map((c, i) => (
        <td
          key={i}
          className={cn(
            "border border-border px-2 py-1.5",
            i % 3 === 1 ? "min-w-[14rem] max-w-xs whitespace-pre-wrap" : "whitespace-nowrap",
          )}
        >
          {c}
        </td>
      ))}
    </>
  );
}
