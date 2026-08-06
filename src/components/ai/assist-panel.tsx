"use client";

import { useState } from "react";
import { Sparkles, Loader2, Copy, Check, RefreshCw } from "lucide-react";
import { Button, ScoreBadge } from "@/components/ui";
import { api } from "@/lib/client";
import { cn, copyToClipboard, formatIST } from "@/lib/utils";
import type { EnquiryDTO, AssistResultDTO } from "@/lib/types";

const PRIORITY_STYLE: Record<string, string> = {
  high: "bg-rose-100 text-rose-700",
  medium: "bg-amber-100 text-amber-700",
  low: "bg-secondary text-secondary-foreground",
};

export function AssistPanel({ enquiry, onUpdated }: {
  enquiry: EnquiryDTO;
  onUpdated: (e: EnquiryDTO) => void;
}) {
  const [result, setResult] = useState<AssistResultDTO | null>(enquiry.aiAssist);
  const [generatedAt, setGeneratedAt] = useState<string | null>(enquiry.aiAssistAt);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const fresh = await api.post<AssistResultDTO>("/api/ai/assist", { enquiryId: enquiry.id });
      const now = new Date().toISOString();
      setResult(fresh);
      setGeneratedAt(now);
      onUpdated({ ...enquiry, aiAssist: fresh, aiAssistAt: now });
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI assist failed");
    } finally {
      setLoading(false);
    }
  }

  async function copyDraft() {
    if (!result) return;
    const ok = await copyToClipboard(
      `Subject: ${result.draft.subject}\n\n${result.draft.body}`,
    );
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="space-y-4">
      {enquiry.aiScore !== null && (
        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary/40 p-3">
          <ScoreBadge score={enquiry.aiScore} className="mt-1" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Conversion likelihood</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {enquiry.aiScoreReason ?? "Scored by the background AI pipeline."}
            </p>
          </div>
        </div>
      )}

      {!result && (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <Sparkles className="h-8 w-8 text-brand-500" />
          <p className="max-w-xs text-sm text-muted-foreground">
            Analyse this lead&apos;s full history — emails, calls, notes and tasks —
            and get suggested next steps plus a draft reply.
          </p>
          <Button onClick={generate} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {loading ? "Thinking…" : "Generate suggestions"}
          </Button>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}

      {result && (
        <>
          {generatedAt && (
            <p className="text-[11px] text-muted-foreground">
              Generated {formatIST(generatedAt, { dateStyle: "medium", timeStyle: "short" })}
            </p>
          )}

          <section>
            <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Situation
            </h3>
            {/* break-words: model output often contains long unbroken URLs. */}
            <p className="break-words text-sm text-foreground">{result.summary}</p>
          </section>

          <section>
            <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Suggested next actions
            </h3>
            <div className="space-y-2">
              {result.nextActions.map((a, i) => (
                <div key={i} className="rounded-lg border border-border p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 break-words text-sm font-medium text-foreground">{a.title}</span>
                    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase", PRIORITY_STYLE[a.priority] ?? PRIORITY_STYLE.low)}>
                      {a.priority}
                    </span>
                  </div>
                  <p className="mt-0.5 break-words text-xs text-muted-foreground">{a.reason}</p>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Draft reply
              </h3>
              <button
                onClick={copyDraft}
                className="flex items-center gap-1 text-xs text-brand-600 hover:underline"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="rounded-lg border border-border bg-secondary/40 p-3">
              <p className="break-words text-xs font-medium text-foreground">
                Subject: {result.draft.subject}
              </p>
              {/* whitespace-pre-wrap alone won't break a long unbroken URL. */}
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">
                {result.draft.body}
              </p>
            </div>
          </section>

          <Button variant="outline" onClick={generate} disabled={loading} className="w-full">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Regenerate
          </Button>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </>
      )}
    </div>
  );
}
