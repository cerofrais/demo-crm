"use client";

import { useCallback, useEffect, useState } from "react";
import {
  MessageSquareQuote, Loader2, Sparkles, Copy, Check, AlertTriangle, RefreshCw, ChevronDown,
} from "lucide-react";
import { Card, Badge, Button, Select } from "@/components/ui";
import { api } from "@/lib/client";
import { MessageBody } from "@/components/messaging/message-body";
import { cn } from "@/lib/utils";

interface TopicStat {
  key: string;
  label: string;
  description: string;
  primaryCount: number;
  primaryShare: number;
  count: number;
  share: number;
  examples: string[];
  existingTemplates: { name: string; channels: string[] }[];
  gap: boolean;
}

interface Analysis {
  from: string;
  to: string;
  totalInbound: number;
  analysed: number;
  noise: number;
  internal: number;
  forms: number;
  byChannel: Record<string, number>;
  unmatched: number;
  unmatchedExamples: string[];
  topics: TopicStat[];
}

interface Suggestion {
  name: string;
  body: string;
  rationale: string;
  coversQuestions: string[];
}

export function InboundQuestions() {
  const [data, setData] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState("90");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<Analysis>(`/api/ai/inbound-analysis?days=${days}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to analyse messages");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  async function draft(topic: TopicStat) {
    setDrafting(topic.key);
    setError(null);
    try {
      const s = await api.post<Suggestion>("/api/ai/inbound-analysis/suggest", {
        topic: topic.key,
        examples: topic.examples,
      });
      setSuggestions((prev) => ({ ...prev, [topic.key]: s }));
      setExpanded(topic.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't draft a template");
    } finally {
      setDrafting(null);
    }
  }

  async function copy(key: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  const gaps = data?.topics.filter((t) => t.gap) ?? [];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-xs text-muted-foreground">
          Every inbound guest message grouped into the questions they keep asking. Grouping is rule-based,
          so the same period always gives the same numbers — the AI is used only when you ask it to draft
          a template.
        </p>
        <div className="flex gap-2">
          <Select value={days} onChange={(e) => setDays(e.target.value)} className="h-8 w-32 text-xs">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last year</option>
            <option value="730">Everything</option>
          </Select>
          <Button size="sm" variant="outline" onClick={load} className="h-8 gap-1 text-xs">
            <RefreshCw className="h-3 w-3" /> Refresh
          </Button>
        </div>
      </div>

      {error && <Card className="border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</Card>}

      {loading && !data ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card className="p-3">
              <p className="text-xs text-muted-foreground">Guest messages</p>
              <p className="text-2xl font-bold">{data.analysed.toLocaleString()}</p>
              {/* Both channels are analysed together — the split is shown so
                  it's clear neither is being missed. */}
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {(data.byChannel.whatsapp ?? 0).toLocaleString()} WhatsApp ·{" "}
                {(data.byChannel.email ?? 0).toLocaleString()} email
              </p>
            </Card>
            <Card className="p-3">
              <p className="text-xs text-muted-foreground">Question topics</p>
              <p className="text-2xl font-bold">{data.topics.length}</p>
            </Card>
            <Card className="p-3">
              <p className="text-xs text-muted-foreground">Topics with no template</p>
              <p className={cn("text-2xl font-bold", gaps.length ? "text-amber-600" : "text-emerald-600")}>
                {gaps.length}
              </p>
            </Card>
            <Card className="p-3">
              <p className="text-xs text-muted-foreground">Unrecognised</p>
              <p className="text-2xl font-bold">{data.unmatched.toLocaleString()}</p>
            </Card>
          </div>

          {gaps.length > 0 && (
            <Card className="border-amber-200 bg-amber-50/60 p-3">
              <p className="text-xs font-medium text-amber-900">
                <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                {gaps.length} topic{gaps.length === 1 ? "" : "s"} guests ask about with no template in the
                library — reps are writing these from scratch every time.
              </p>
              <p className="mt-1 text-xs text-amber-800">
                {gaps.map((g) => `${g.label} (${g.count})`).join(" · ")}
              </p>
            </Card>
          )}

          <div className="space-y-2">
            {data.topics.map((t) => {
              const suggestion = suggestions[t.key];
              const open = expanded === t.key;
              return (
                <Card key={t.key} className="overflow-hidden">
                  <button
                    onClick={() => setExpanded(open ? null : t.key)}
                    className="flex w-full items-start gap-3 p-4 text-left hover:bg-secondary/40"
                  >
                    <ChevronDown
                      className={cn(
                        "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                        open && "rotate-180",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{t.label}</span>
                        <Badge className="bg-secondary text-[10px]">{t.primaryCount} asked</Badge>
                        <Badge className="bg-brand-100 text-[10px] text-brand-700">{t.primaryShare}%</Badge>
                        {t.count > t.primaryCount && (
                          <span className="text-[10px] text-muted-foreground">
                            +{t.count - t.primaryCount} alongside other topics
                          </span>
                        )}
                        {t.gap ? (
                          <Badge className="bg-amber-100 text-[10px] text-amber-800">no template</Badge>
                        ) : (
                          <Badge className="bg-emerald-100 text-[10px] text-emerald-700">
                            {t.existingTemplates.length} template
                            {t.existingTemplates.length === 1 ? "" : "s"}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>
                      {/* Share bar — reads faster than the number alone. */}
                      <div className="mt-1.5 h-1 w-full max-w-md overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full rounded-full bg-brand-500"
                          style={{ width: `${Math.min(t.primaryShare, 100)}%` }}
                        />
                      </div>
                    </div>
                  </button>

                  {open && (
                    <div className="border-t border-border bg-muted/20 p-4">
                      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        What guests actually wrote
                      </h4>
                      <div className="mb-4 space-y-1.5">
                        {t.examples.map((e, i) => (
                          <div
                            key={i}
                            className="rounded-md border-l-2 border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground"
                          >
                            {/* Same renderer as the message threads, so a long
                                example collapses with a "show full message"
                                toggle instead of being cut off. */}
                            <MessageBody body={e} className="text-xs" />
                          </div>
                        ))}
                      </div>

                      {t.existingTemplates.length > 0 && (
                        <div className="mb-4">
                          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Templates that already cover this
                          </h4>
                          <div className="flex flex-wrap gap-1.5">
                            {t.existingTemplates.map((tpl) => (
                              <Badge key={tpl.name} className="bg-secondary text-[10px]">
                                {tpl.name}
                                <span className="ml-1 opacity-60">{tpl.channels.join(" + ")}</span>
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {suggestion ? (
                        <div className="rounded-md border border-brand-200 bg-brand-50/50 p-3">
                          <div className="mb-1.5 flex flex-wrap items-center gap-2">
                            <Sparkles className="h-3.5 w-3.5 text-brand-600" />
                            <span className="text-xs font-medium">{suggestion.name}</span>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => copy(t.key, suggestion.body)}
                              className="ml-auto h-7 gap-1 text-[11px]"
                            >
                              {copied === t.key ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                              {copied === t.key ? "Copied" : "Copy"}
                            </Button>
                          </div>
                          <p className="whitespace-pre-wrap rounded-md bg-background p-2.5 text-xs">
                            {suggestion.body}
                          </p>
                          <p className="mt-2 text-[11px] text-muted-foreground">{suggestion.rationale}</p>
                          <p className="mt-2 text-[11px] text-muted-foreground">
                            A draft, not a saved template — check the [placeholders], then add it from
                            Message Templates.
                          </p>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => draft(t)}
                          disabled={drafting === t.key}
                          className="h-8 gap-1 text-xs"
                        >
                          {drafting === t.key ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Sparkles className="h-3 w-3" />
                          )}
                          Draft a template for this
                        </Button>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>

          {data.unmatchedExamples.length > 0 && (
            <Card className="p-4">
              <h4 className="text-xs font-semibold">
                Didn&apos;t fit any topic ({data.unmatched.toLocaleString()})
              </h4>
              <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">
                Shown so the blind spots stay visible — if a real question keeps appearing here, the
                topic list needs a new entry.
              </p>
              <div className="space-y-1">
                {data.unmatchedExamples.slice(0, 10).map((e, i) => (
                  <p key={i} className="truncate text-xs text-muted-foreground">
                    {e}
                  </p>
                ))}
              </div>
            </Card>
          )}

          <p className="text-[11px] text-muted-foreground">
            <MessageSquareQuote className="mr-1 inline h-3 w-3" />
            Excluded before analysis: {data.forms.toLocaleString()} website/health form submission
            {data.forms === 1 ? "" : "s"}, {data.noise.toLocaleString()} acknowledgement
            {data.noise === 1 ? "" : "s"} and system labels, and {data.internal.toLocaleString()} staff
            message{data.internal === 1 ? "" : "s"} — none of them are a guest asking something.
            Percentages are by each message&apos;s main topic, so they sum to 100; the &ldquo;alongside&rdquo;
            figure counts messages where the topic came up as a secondary point.
          </p>
        </>
      )}
    </div>
  );
}
