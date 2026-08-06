"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Printer } from "lucide-react";
import { Select, Button, Input } from "@/components/ui";
import { api } from "@/lib/client";
import { STAGES } from "@/lib/kanban";
import { formatIST } from "@/lib/utils";
import { PerformanceTable, type PerformanceRow } from "./performance-table";
import { SourceStageMatrix, SOURCES, type MatrixRow } from "./source-stage-matrix";

const PERIOD_LABEL: Record<string, string> = {
  day: "Last 24 hours",
  week: "Last 7 days",
  month: "Last 30 days",
  all: "All time",
};

/**
 * Owns the one date-range filter shared by both report tables below it, and
 * the single Print button that prints them together — previously each table
 * had its own filter (only Performance did, really) and the matrix had none
 * at all / wasn't part of the print output.
 */
export function ReportsWorkspace() {
  const [period, setPeriod] = useState("week");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [source, setSource] = useState("");
  const [campaignInput, setCampaignInput] = useState("");
  const [campaignLabel, setCampaignLabel] = useState("");
  const [campaignOptions, setCampaignOptions] = useState<string[]>([]);
  const [perfRows, setPerfRows] = useState<PerformanceRow[]>([]);
  const [matrixRows, setMatrixRows] = useState<MatrixRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<string[]>("/api/reports/campaigns").then(setCampaignOptions).catch(() => {});
  }, []);

  const isCustom = period === "custom";
  // Same date twice is a valid single-day range — only reject start > end.
  const customRangeReady = isCustom && !!customStart && !!customEnd && customStart <= customEnd;

  // Debounce the campaign text filter so typing doesn't fire a request per
  // keystroke — same 400ms pattern as the New Lead dialog's duplicate check.
  useEffect(() => {
    const t = setTimeout(() => setCampaignLabel(campaignInput), 400);
    return () => clearTimeout(t);
  }, [campaignInput]);

  const load = useCallback(async () => {
    if (isCustom && !customRangeReady) return; // wait until both ends of the range are picked
    setLoading(true);
    try {
      const range = isCustom ? `startDate=${customStart}&endDate=${customEnd}` : `period=${period}`;
      const extra = new URLSearchParams();
      if (source) extra.set("source", source);
      if (campaignLabel.trim()) extra.set("campaignLabel", campaignLabel.trim());
      const qs = extra.toString() ? `${range}&${extra}` : range;
      const [perf, matrix] = await Promise.all([
        api.get<PerformanceRow[]>(`/api/reports/performance?${qs}`),
        api.get<MatrixRow[]>(`/api/reports/source-stage-matrix?${qs}`),
      ]);
      setPerfRows(perf);
      setMatrixRows(matrix);
    } finally {
      setLoading(false);
    }
  }, [period, isCustom, customRangeReady, customStart, customEnd, source, campaignLabel]);

  useEffect(() => {
    load();
  }, [load]);

  function exportCsv() {
    const escapeRow = (row: (string | number)[]) =>
      row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",");

    const perfHeaders = ["Staff", "Leads created", "Stage moves", "Remarks", "Docs", "Conversions"];
    const perfBody = perfRows.map((r) => [
      r.name,
      r.leadsCreated,
      r.stageChanges,
      r.notes,
      r.docsUploaded,
      r.conversions,
    ]);

    // Same source x stage grid the on-screen table renders, reconstructed
    // from the flat {source, stage, count} rows the API returns.
    const matrixCell = (src: string, stage: string) =>
      matrixRows.find((r) => r.source === src && r.stage === stage)?.count ?? 0;
    const matrixRowTotal = (src: string) =>
      matrixRows.filter((r) => r.source === src).reduce((a, r) => a + r.count, 0);
    const matrixColTotal = (stage: string) =>
      matrixRows.filter((r) => r.stage === stage).reduce((a, r) => a + r.count, 0);
    const matrixGrandTotal = matrixRows.reduce((a, r) => a + r.count, 0);
    const matrixHeaders = ["Source", ...STAGES.map((s) => s.label), "Total"];
    const matrixBody = [
      ...SOURCES.map((src) => [
        src.replace("_", " "),
        ...STAGES.map((s) => matrixCell(src, s.id)),
        matrixRowTotal(src),
      ]),
      ["Total", ...STAGES.map((s) => matrixColTotal(s.id)), matrixGrandTotal],
    ];

    const csv = [
      "Front-office performance",
      escapeRow(perfHeaders),
      ...perfBody.map(escapeRow),
      "",
      "Source x stage matrix",
      escapeRow(matrixHeaders),
      ...matrixBody.map(escapeRow),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tre-reports-${period}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const rangeLabel = isCustom
    ? customRangeReady
      ? `${customStart} to ${customEnd}`
      : "Custom range"
    : (PERIOD_LABEL[period] ?? period);

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="no-print flex flex-wrap items-center justify-end gap-2">
        <Select value={period} onChange={(e) => setPeriod(e.target.value)} className="w-36">
          <option value="day">Last 24 hours</option>
          <option value="week">Last 7 days</option>
          <option value="month">Last 30 days</option>
          <option value="all">All time</option>
          <option value="custom">Custom range…</option>
        </Select>
        {isCustom && (
          <>
            <Input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="w-36 lg:h-9"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="w-36 lg:h-9"
            />
          </>
        )}
        <Select value={source} onChange={(e) => setSource(e.target.value)} className="w-40 lg:h-9">
          <option value="">All sources</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>{s.replace("_", " ")}</option>
          ))}
        </Select>
        <Input
          type="text"
          list="tre-campaign-vocab"
          placeholder="Filter by campaign…"
          value={campaignInput}
          onChange={(e) => setCampaignInput(e.target.value)}
          className="w-44 lg:h-9"
        />
        <datalist id="tre-campaign-vocab">
          {campaignOptions.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <Button
          variant="outline"
          size="icon"
          onClick={() => window.print()}
          disabled={perfRows.length === 0 && matrixRows.length === 0}
          title="Print / Save as PDF"
        >
          <Printer className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={exportCsv}
          disabled={perfRows.length === 0 && matrixRows.length === 0}
          title="Export report as CSV"
        >
          <Download className="h-4 w-4" />
        </Button>
      </div>

      <div className="print-only hidden text-sm text-muted-foreground">
        Reports — {rangeLabel}
        {source ? ` — source: ${source.replace("_", " ")}` : ""}
        {campaignLabel ? ` — campaign: "${campaignLabel}"` : ""} — generated{" "}
        {formatIST(new Date(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
      </div>

      <div className="print-area space-y-6">
        <PerformanceTable rows={perfRows} loading={loading} />
        <SourceStageMatrix rows={matrixRows} />
      </div>
    </div>
  );
}
