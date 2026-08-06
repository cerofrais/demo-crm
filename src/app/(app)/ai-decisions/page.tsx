"use client";

import { useEffect, useState, useCallback } from "react";
import { ShieldCheck, ShieldAlert, RefreshCw, CheckCircle2, XCircle, Filter, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Card, Badge, Button, Select, Sheet } from "@/components/ui";
import { api } from "@/lib/client";
import { cn, formatIST } from "@/lib/utils";
import type { AiDecisionListItemDTO, AiDecisionDetailDTO } from "@/lib/ai-decisions";

const KIND_LABEL: Record<string, string> = {
  call_analysis: "Call analysis",
  lead_scoring: "Lead scoring",
  guest_insight: "Guest insight",
  conversation_assist: "Conversation assist",
  transcript_translation: "Transcript translation",
};

const KIND_COLOR: Record<string, string> = {
  call_analysis: "bg-blue-100 text-blue-800",
  lead_scoring: "bg-brand-100 text-brand-700",
  guest_insight: "bg-purple-100 text-purple-800",
  conversation_assist: "bg-amber-100 text-amber-800",
  transcript_translation: "bg-teal-100 text-teal-800",
};

function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export default function AiDecisionsPage() {
  const [items, setItems] = useState<AiDecisionListItemDTO[]>([]);
  const [stats, setStats] = useState<{ total: number; success: number; failed: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [kind, setKind] = useState("");
  const [success, setSuccess] = useState("");
  const [selected, setSelected] = useState<AiDecisionDetailDTO | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (success) params.set("success", success);
    if (cursor) params.set("cursor", cursor);

    // A 403/500/network failure used to throw past `setLoading(false)`, leaving
    // the page stuck on "Loading decisions…" forever with an unhandled rejection.
    try {
      const res = await fetch(`/api/ai/decisions?${params}`);
      if (!res.ok) throw new Error(`Failed to load decisions (${res.status})`);
      const json = await res.json();
      const data = json.data as { items: AiDecisionListItemDTO[]; nextCursor: string | null };
      const meta = json.meta as { stats: { total: number; success: number; failed: number } };
      if (cursor) {
        setItems((prev) => [...prev, ...data.items]);
      } else {
        setItems(data.items);
      }
      setNextCursor(data.nextCursor);
      setStats(meta.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load decisions");
    } finally {
      setLoading(false);
    }
  }, [kind, success]);

  useEffect(() => { load(); }, [load]);

  async function openDetail(id: string) {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const decision = await api.get<AiDecisionDetailDTO>(`/api/ai/decisions/${id}`);
      setSelected(decision);
    } catch (err) {
      // Surface the failure in the Sheet rather than silently closing it.
      setDetailError(err instanceof Error ? err.message : "Failed to load decision");
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="AI Audit"
        subtitle="Every AI/ML decision the system has made — exact prompt sent, exact output received. Admin only."
      />

      {stats && (
        <div className="grid grid-cols-3 gap-3 p-4 pb-0 md:p-6 md:pb-0">
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Total decisions</p>
            <p className="text-2xl font-bold text-foreground">{stats.total}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Successful</p>
            <p className="text-2xl font-bold text-brand-600">{stats.success}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Failed</p>
            <p className="text-2xl font-bold text-rose-600">{stats.failed}</p>
          </Card>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2 p-4 pb-0 md:p-6 md:pb-0">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Filter className="h-3.5 w-3.5" /> Filters:
        </div>
        {/* Keep the primitive's 44px / 16px phone sizing (avoids iOS focus zoom);
            only go compact from lg up. */}
        <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-48 lg:h-8 lg:text-xs">
          <option value="">All decision types</option>
          {Object.entries(KIND_LABEL).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </Select>
        <Select value={success} onChange={(e) => setSuccess(e.target.value)} className="w-36 lg:h-8 lg:text-xs">
          <option value="">All outcomes</option>
          <option value="true">Success only</option>
          <option value="false">Failed only</option>
        </Select>
        <Button size="sm" variant="outline" onClick={() => load()} className="h-8 gap-1 text-xs">
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
      </div>

      <div className="p-4 md:p-6">
        <Card className="overflow-hidden">
          {loading && !items.length ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <ShieldCheck className="mr-2 h-5 w-5 animate-pulse" /> Loading decisions…
            </div>
          ) : error && !items.length ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
              <ShieldAlert className="h-10 w-10 opacity-30" />
              <p className="max-w-md text-sm">{error}</p>
              <Button size="sm" variant="outline" onClick={() => load()}>Retry</Button>
            </div>
          ) : !items.length ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
              <ShieldCheck className="h-10 w-10 opacity-20" />
              <p>No AI decisions recorded yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40">
                  <tr>
                    {["Type", "Entity", "Model", "Outcome", "Duration", "Triggered by", "When"].map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((d) => (
                    <tr
                      key={d.id}
                      onClick={() => openDetail(d.id)}
                      className="cursor-pointer hover:bg-muted/20"
                    >
                      <td className="px-3 py-2.5">
                        <Badge className={cn("text-xs", KIND_COLOR[d.kind] ?? "bg-secondary text-secondary-foreground")}>
                          {KIND_LABEL[d.kind] ?? d.kind}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 text-xs">{d.guestName ?? "—"}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{d.model}</td>
                      <td className="px-3 py-2.5">
                        {d.success ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-brand-600">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Success
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-rose-600" title={d.errorMessage ?? undefined}>
                            <XCircle className="h-3.5 w-3.5" /> Failed
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs">{fmtDuration(d.durationMs)}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">
                        {d.triggeredBy === "pipeline" ? "Background pipeline" : (d.triggeredByName ?? d.triggeredBy ?? "—")}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                        {formatIST(d.createdAt, { dateStyle: "short", timeStyle: "short" })}
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

      <Sheet
        open={!!(selected || detailLoading || detailError)}
        onClose={() => { setSelected(null); setDetailError(null); }}
        side="right"
        widthClassName="w-full max-w-2xl"
        title="Decision detail"
        ariaLabel="AI decision detail"
      >
            <div className="px-4 py-4 md:px-6">
              {detailLoading && !selected ? (
                <div className="flex justify-center py-16 text-muted-foreground">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : detailError && !selected ? (
                <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
                  <ShieldAlert className="h-10 w-10 opacity-30" />
                  <p className="max-w-sm text-sm">{detailError}</p>
                </div>
              ) : selected ? (
                <div className="space-y-5">
                  <div className="grid grid-cols-1 gap-3 rounded-lg bg-secondary/50 p-3 text-sm sm:grid-cols-2">
                    <Field label="Type" value={KIND_LABEL[selected.kind] ?? selected.kind} />
                    <Field label="Model" value={`${selected.provider} / ${selected.model}`} />
                    <Field label="Outcome" value={selected.success ? "Success" : `Failed — ${selected.errorMessage ?? "unknown error"}`} />
                    <Field label="Duration" value={fmtDuration(selected.durationMs)} />
                    <Field label="Triggered by" value={selected.triggeredBy === "pipeline" ? "Background pipeline" : (selected.triggeredByName ?? selected.triggeredBy ?? "—")} />
                    <Field label="When" value={formatIST(selected.createdAt, { dateStyle: "medium", timeStyle: "short" })} />
                    {selected.guestName && <Field label="Guest" value={selected.guestName} />}
                  </div>

                  <section>
                    <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      System prompt
                    </h3>
                    <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-secondary/30 p-3 text-xs text-foreground">
                      {selected.promptSystem}
                    </pre>
                  </section>

                  <section>
                    <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      User prompt (exact context sent to the model)
                    </h3>
                    <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-secondary/30 p-3 text-xs text-foreground">
                      {selected.promptUser}
                    </pre>
                  </section>

                  <section>
                    <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Output
                    </h3>
                    <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-secondary/30 p-3 text-xs text-foreground">
                      {selected.output ? JSON.stringify(selected.output, null, 2) : "(none — see outcome above)"}
                    </pre>
                  </section>
                </div>
              ) : null}
            </div>
      </Sheet>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium text-foreground">{value}</div>
    </div>
  );
}
