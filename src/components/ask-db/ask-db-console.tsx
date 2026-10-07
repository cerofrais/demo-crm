"use client";

/**
 * The Ask-the-Database console.
 *
 * The SQL is never hidden. An admin reading "1,240" has no way to know whether
 * the model counted leads or people, included deleted rows, or used the wrong
 * date column — so the query sits above the table, editable, with a Run button
 * of its own. Editing it skips the model entirely and goes straight to the
 * same read-only execution path.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Copy, Database, Download, History, Loader2, Pencil, Play, Sparkles, User } from "lucide-react";
import { Badge, Button, Card, Textarea } from "@/components/ui";
import { api } from "@/lib/client";

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

interface AskedQuestion {
  id: string;
  question: string;
  at: string;
  ok: boolean;
  mode: "sql" | "lead" | null;
  by: string | null;
  mine: boolean;
  hasAnswer: boolean;
}

/** An answer kept from when the question was first asked. */
interface SavedRecord {
  id: string;
  question: string;
  sql: string | null;
  askedAt: string;
  askedBy: string | null;
  answer:
    | { mode: "sql"; explanation: string | null; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; rowsTrimmed: boolean }
    | { mode: "lead"; answer: string; lead: { enquiryId: string; name: string; stage: string } | null; evidence: EvidenceRow[] };
}

interface LeadCard {
  enquiryId: string;
  guestId: string;
  name: string;
  phone: string | null;
  city: string | null;
  stage: string;
  source: string;
  owner: string | null;
  campaignLabel: string | null;
  tags: string[];
  createdAt: string;
  lastActivityAt: string;
  deleted: boolean;
}

interface TimelineRow {
  ts: number;
  at: string;
  kind: "stage" | "message" | "call" | "note" | "task" | "event";
  who: string;
  detail: string;
}

type EvidenceRow = TimelineRow & { n: number };

type Answer =
  | { ok: true; mode: "sql"; question: string; sql: string; explanation: string; result: QueryResult; attempts: number; model: string; generationMs: number }
  | { ok: false; mode: "sql"; question: string; sql: string | null; explanation: string | null; error: string; attempts: number; model: string }
  | { ok: true; mode: "lead"; question: string; answer: string; lead: LeadCard; evidence: EvidenceRow[]; timeline: TimelineRow[]; model: string; generationMs: number }
  | { ok: false; mode: "choose"; question: string; name: string; candidates: LeadCard[]; error: string };

export function AskDbConsole({
  enabled,
  model,
  samples,
  tables,
}: {
  enabled: boolean;
  model: string;
  samples: string[];
  tables: string[];
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [history, setHistory] = useState<AskedQuestion[]>([]);
  const [saved, setSaved] = useState<SavedRecord | null>(null);

  // The history is the AI audit log read back, so it is reloaded after each
  // question rather than guessed at locally — what the page shows is then the
  // same record an audit would find.
  const loadHistory = useCallback(() => {
    api
      .get<AskedQuestion[]>("/api/admin/ask-db/history")
      .then(setHistory)
      .catch(() => {
        /* the console still works without its history */
      });
  }, []);

  useEffect(loadHistory, [loadHistory]);
  const [draftSql, setDraftSql] = useState("");

  const ask = useCallback(
    async (body: { question: string; sql?: string; enquiryId?: string }) => {
      if (!body.question.trim()) return;
      setBusy(true);
      setError(null);
      try {
        const res = await api.post<Answer>("/api/admin/ask-db", body);
        setAnswer(res);
        setSaved(null);
        setEditing(false);
        setShowTimeline(false);
        if (res.mode === "sql" && res.sql) setDraftSql(res.sql);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setBusy(false);
        loadHistory();
      }
    },
    [loadHistory],
  );

  /** Re-open a past question's own answer. No model call, no query. */
  const openSaved = useCallback(async (h: AskedQuestion) => {
    setQuestion(h.question);
    setError(null);
    if (!h.hasAnswer) {
      // Asked before answers were kept: the only way to see one is to ask.
      await ask({ question: h.question });
      return;
    }
    setBusy(true);
    try {
      const record = await api.get<SavedRecord>(`/api/admin/ask-db/history/${h.id}`);
      setSaved(record);
      setAnswer(null);
      if (record.sql) setDraftSql(record.sql);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open that answer.");
    } finally {
      setBusy(false);
    }
  }, [ask]);

  const downloadCsv = useCallback(() => {
    if (!answer?.ok || answer.mode !== "sql") return;
    const { columns, rows } = answer.result;
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `ask-db-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [answer]);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <Card className="space-y-3 p-4">
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask({ question });
          }}
          placeholder="What are all the messages sent from the 61 number in the last 10 days?&#10;What is happening with the lead Seema Rani, why is she in contacted?"
          rows={3}
          disabled={busy}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => ask({ question })} disabled={busy || !question.trim() || !enabled}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {busy ? "Thinking…" : "Ask"}
          </Button>
          <span className="text-xs text-muted-foreground">
            ⌘/Ctrl + Enter · answered by {model} on this box · nothing leaves the server
          </span>
        </div>

        <div className="text-xs text-muted-foreground">
          Ask about the business and you get a table with the SQL behind it. Ask about one person by name — &ldquo;what is
          happening with the lead Seema Rani, why is she in contacted?&rdquo; — and you get a short account of what happened,
          with the messages, calls and notes it rests on quoted underneath.
        </div>

        {!enabled && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            The model is switched off on this deployment (AI_ENABLED / AI_FEATURE_ASK_DB). SQL you write by hand still runs.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {samples.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setQuestion(s);
                ask({ question: s });
              }}
              disabled={busy}
              className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>

        {history.length > 0 && (
          <div className="space-y-1 border-t border-border pt-3">
            <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <History className="h-3.5 w-3.5" /> Asked before
            </p>
            {history.map((h) => (
              <button
                key={h.id}
                type="button"
                disabled={busy}
                onClick={() => openSaved(h)}
                className="flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50"
              >
                <span className="truncate">{h.question}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  {!h.ok && <span className="text-amber-700 dark:text-amber-400">no answer</span>}
                  {h.ok && !h.hasAnswer && <span title="Asked before answers were kept">not kept</span>}
                  {h.mode && <span>{h.mode === "lead" ? "lead" : "SQL"}</span>}
                  {!h.mine && h.by && <span>{h.by}</span>}
                  <span>{h.at}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </Card>

      {error && (
        <Card className="flex items-start gap-2 border-destructive/40 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </Card>
      )}

      {saved && (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <History className="h-3.5 w-3.5" />
              Saved answer, from when this was asked on {new Date(saved.askedAt).toLocaleString("en-GB", {
                day: "2-digit",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })}
              {saved.askedBy ? ` by ${saved.askedBy}` : ""}
            </p>
            <Button size="sm" variant="outline" onClick={() => ask({ question: saved.question })} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Run again
            </Button>
          </div>

          {saved.answer.mode === "lead" ? (
            <SavedLeadView answer={saved.answer} />
          ) : (
            <SavedSqlView answer={saved.answer} sql={saved.sql} />
          )}
        </Card>
      )}

      {answer?.mode === "choose" && (
        <Card className="space-y-3 p-4">
          <p className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span>{answer.error}</span>
          </p>
          {answer.candidates.map((c) => (
            <button
              key={c.enquiryId}
              type="button"
              disabled={busy}
              onClick={() => ask({ question: answer.question, enquiryId: c.enquiryId })}
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50"
            >
              <span className="font-medium">{c.name}</span>
              <Badge className="bg-secondary text-secondary-foreground">{c.stage}</Badge>
              {c.deleted && <Badge className="bg-destructive/10 text-destructive">deleted</Badge>}
              <span className="text-xs text-muted-foreground">
                {c.phone ?? "no phone"} · {c.source} · {c.owner ?? "unassigned"} · last activity {c.lastActivityAt}
              </span>
            </button>
          ))}
        </Card>
      )}

      {answer?.mode === "lead" && (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <User className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{answer.lead.name}</span>
            <Badge className="bg-secondary text-secondary-foreground">{answer.lead.stage}</Badge>
            {answer.lead.deleted && <Badge className="bg-destructive/10 text-destructive">deleted</Badge>}
            <span className="text-xs text-muted-foreground">
              {answer.lead.phone ?? "no phone"} · {answer.lead.source} · {answer.lead.owner ?? "unassigned"}
              {answer.lead.campaignLabel ? ` · ${answer.lead.campaignLabel}` : ""} · created {answer.lead.createdAt}
            </span>
            <a href={`/leads?lead=${answer.lead.enquiryId}`} className="text-xs font-medium text-primary underline-offset-2 hover:underline">
              open the lead
            </a>
          </div>

          <p className="whitespace-pre-line text-sm leading-relaxed text-foreground">{answer.answer}</p>

          <div className="space-y-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Proof — the entries this is based on, word for word
            </span>
            {answer.evidence.map((row) => (
              <div key={row.n} className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span className="font-mono font-medium text-foreground">[{row.n}]</span>
                  <span>{row.at}</span>
                  <span>·</span>
                  <span className="font-medium">{row.kind}</span>
                  <span>·</span>
                  <span>{row.who}</span>
                </div>
                <p className="mt-1 leading-relaxed">{row.detail}</p>
              </div>
            ))}
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowTimeline((v) => !v)}
              className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
            >
              {showTimeline ? "Hide" : "Show"} everything it read — {answer.timeline.length}{" "}
              {answer.timeline.length === 1 ? "entry" : "entries"}, newest first
            </button>
            {showTimeline && (
              <div className="mt-2 overflow-x-auto rounded-md border border-border">
                <table className="w-full border-collapse text-sm">
                  <tbody>
                    {answer.timeline.map((row, i) => (
                      <tr key={i} className="border-t border-border first:border-t-0">
                        <td className="px-3 py-2 align-top font-mono text-xs text-muted-foreground">[{i + 1}]</td>
                        <td className="whitespace-nowrap px-3 py-2 align-top text-xs text-muted-foreground">{row.at}</td>
                        <td className="px-3 py-2 align-top text-xs font-medium">{row.kind}</td>
                        <td className="whitespace-nowrap px-3 py-2 align-top text-xs text-muted-foreground">{row.who}</td>
                        <td className="px-3 py-2 align-top">{row.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      )}

      {answer?.mode === "sql" && (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-foreground">
              {answer.ok ? answer.explanation : (answer.explanation ?? "No answer.")}
            </p>
            {answer.ok && (
              <div className="flex items-center gap-2">
                <Badge className="bg-secondary text-secondary-foreground">
                  {answer.result.rowCount} {answer.result.rowCount === 1 ? "row" : "rows"}
                </Badge>
                <span className="text-xs text-muted-foreground">{answer.result.durationMs} ms</span>
                {answer.result.rowCount > 0 && (
                  <Button variant="ghost" size="sm" onClick={downloadCsv}>
                    <Download className="h-4 w-4" /> CSV
                  </Button>
                )}
              </div>
            )}
          </div>

          {!answer.ok && (
            <p className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{answer.error}</span>
            </p>
          )}

          {(answer.sql || editing) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  SQL {answer.attempts > 1 && `· corrected itself after ${answer.attempts - 1} failed attempt`}
                </span>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(draftSql)}>
                    <Copy className="h-4 w-4" /> Copy
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)}>
                    <Pencil className="h-4 w-4" /> {editing ? "Done" : "Edit"}
                  </Button>
                </div>
              </div>
              {editing ? (
                <div className="space-y-2">
                  <Textarea
                    value={draftSql}
                    onChange={(e) => setDraftSql(e.target.value)}
                    rows={8}
                    className="font-mono text-xs"
                  />
                  <Button size="sm" onClick={() => ask({ question: answer.question, sql: draftSql })} disabled={busy}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Run this SQL
                  </Button>
                </div>
              ) : (
                <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed">{answer.sql}</pre>
              )}
            </div>
          )}

          {answer.ok && answer.result.rowCount > 0 && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-muted/60">
                  <tr>
                    {answer.result.columns.map((c) => (
                      <th key={c} className="whitespace-nowrap px-3 py-2 text-left font-medium">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {answer.result.rows.map((row, i) => (
                    <tr key={i} className="border-t border-border">
                      {answer.result.columns.map((c) => (
                        <td key={c} className="max-w-[28rem] truncate px-3 py-2" title={display(row[c])}>
                          {display(row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {answer.ok && answer.result.rowCount === 0 && (
            <p className="text-sm text-muted-foreground">The query ran and matched nothing.</p>
          )}
          {answer.ok && answer.result.truncated && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Showing the first {answer.result.rowCount} rows — narrow the question, or add your own LIMIT and re-run.
            </p>
          )}
        </Card>
      )}

      <Card className="space-y-1 p-4 text-xs text-muted-foreground">
        <p className="flex items-center gap-2 font-medium text-foreground">
          <Database className="h-4 w-4" /> What this can read
        </p>
        <p>{tables.join(", ")}.</p>
        <p>
          A question about one person is answered from that lead&rsquo;s own stage history, messages, calls, notes and
          tasks. The model picks which entries matter and cites them; the quoted proof underneath is that lead&rsquo;s own
          records, word for word, and the whole history it read is one click away.
        </p>
        <p>
          Read-only: writes are refused by the database itself. Health records, uploaded documents and WhatsApp
          credentials are not reachable from here. Every question is recorded in the AI Audit log with the SQL it ran.
        </p>
      </Card>
    </div>
  );
}

function SavedLeadView({ answer }: { answer: Extract<SavedRecord["answer"], { mode: "lead" }> }) {
  return (
    <>
      {answer.lead && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <User className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{answer.lead.name}</span>
          <Badge className="bg-secondary text-secondary-foreground">{answer.lead.stage}</Badge>
          <a
            href={`/leads?lead=${answer.lead.enquiryId}`}
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            open the lead
          </a>
        </div>
      )}
      <p className="whitespace-pre-line text-sm leading-relaxed text-foreground">{answer.answer}</p>
      {answer.evidence.length > 0 && (
        <div className="space-y-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Proof — the entries this rested on
          </span>
          {answer.evidence.map((row) => (
            <div key={row.n} className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span className="font-mono font-medium text-foreground">[{row.n}]</span>
                <span>{row.at}</span>
                <span>·</span>
                <span className="font-medium">{row.kind}</span>
                <span>·</span>
                <span>{row.who}</span>
              </div>
              <p className="mt-1 leading-relaxed">{row.detail}</p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function SavedSqlView({
  answer,
  sql,
}: {
  answer: Extract<SavedRecord["answer"], { mode: "sql" }>;
  sql: string | null;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground">{answer.explanation}</p>
        <Badge className="bg-secondary text-secondary-foreground">
          {answer.rowCount} {answer.rowCount === 1 ? "row" : "rows"}
        </Badge>
      </div>
      {sql && <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed">{sql}</pre>}
      {answer.rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/60">
              <tr>
                {answer.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-3 py-2 text-left font-medium">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {answer.rows.map((row, i) => (
                <tr key={i} className="border-t border-border">
                  {answer.columns.map((c) => (
                    <td key={c} className="max-w-[28rem] truncate px-3 py-2" title={display(row[c])}>
                      {display(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {answer.rowsTrimmed && (
        <p className="text-xs text-muted-foreground">
          The first {answer.rows.length} of {answer.rowCount} rows were kept. Run it again for the rest — and for
          today&rsquo;s numbers.
        </p>
      )}
      {answer.rowCount === 0 && <p className="text-sm text-muted-foreground">It matched nothing when it was asked.</p>}
    </>
  );
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
