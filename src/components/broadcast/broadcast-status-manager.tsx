"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Send, Loader2, Trash2, ChevronDown, Check, X, Clock, AlertTriangle, Download,
} from "lucide-react";
import { Card, Badge, Button, Dialog } from "@/components/ui";
import { api } from "@/lib/client";
import { cn, formatIST } from "@/lib/utils";

interface BroadcastJobDTO {
  id: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  message: string;
  templateName: string | null;
  templateCategory: string | null;
  usedMarketingApi: boolean;
  numberLabel: string;
  delaySec: number;
  totalCount: number;
  sentCount: number;
  failedCount: number;
  cursor: number;
  createdByName: string;
  createdAt: string;
  completedAt: string | null;
}

interface RecipientDTO {
  guestId: string;
  guestName: string;
  guestPhone: string | null;
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  errorDetail: string | null;
  sentAt: string | null;
}

const JOB_STATUS_COLOR: Record<string, string> = {
  queued: "bg-amber-100 text-amber-700",
  running: "bg-brand-100 text-brand-700",
  completed: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-secondary text-secondary-foreground",
  failed: "bg-destructive/10 text-destructive",
};

const RECIPIENT_STATUS: Record<
  RecipientDTO["status"],
  { label: string; className: string; icon: typeof Check }
> = {
  pending: { label: "Pending", className: "bg-secondary text-secondary-foreground", icon: Clock },
  sent: { label: "Sent", className: "bg-sky-100 text-sky-700", icon: Check },
  delivered: { label: "Delivered", className: "bg-brand-100 text-brand-700", icon: Check },
  read: { label: "Read", className: "bg-emerald-100 text-emerald-700", icon: Check },
  failed: { label: "Failed", className: "bg-destructive/10 text-destructive", icon: X },
};

function formatDateTime(iso: string): string {
  return formatIST(iso, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Error rows are stored as "<code>: <message>" (see broadcast.ts / the
 *  WhatsApp Cloud API status webhook) — split so the code sorts/filters
 *  cleanly as its own CSV column instead of being buried in free text. */
function splitErrorCode(errorDetail: string): { code: string; message: string } {
  const idx = errorDetail.indexOf(":");
  if (idx === -1) return { code: "", message: errorDetail };
  return { code: errorDetail.slice(0, idx).trim(), message: errorDetail.trim() };
}

function downloadFailedRecipientsCsv(job: BroadcastJobDTO, recipients: RecipientDTO[]) {
  const failed = recipients.filter((r) => r.status === "failed");
  const header = ["Name", "Phone", "Error Code", "Error Message"];
  const rows = failed.map((r) => {
    const { code, message } = splitErrorCode(r.errorDetail ?? "");
    return [r.guestName, r.guestPhone ?? "", code, message];
  });
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `broadcast-failures-${job.id.slice(0, 8)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function BroadcastStatusManager({ canDelete }: { canDelete: boolean }) {
  const [jobs, setJobs] = useState<BroadcastJobDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<RecipientDTO[]>([]);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BroadcastJobDTO | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setJobs(await api.get<BroadcastJobDTO[]>("/api/broadcast-status"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load broadcast triggers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleExpand(job: BroadcastJobDTO) {
    if (expanded === job.id) {
      setExpanded(null);
      return;
    }
    setExpanded(job.id);
    setLoadingRecipients(true);
    try {
      const res = await api.get<{ recipients: RecipientDTO[] }>(`/api/broadcast-status/${job.id}`);
      setRecipients(res.recipients);
    } catch {
      setRecipients([]);
    } finally {
      setLoadingRecipients(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4 md:p-6">
      {error && (
        <Card className="border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</Card>
      )}

      {jobs.length === 0 ? (
        <Card className="py-12 text-center text-sm text-muted-foreground">
          No broadcast triggers yet.
        </Card>
      ) : (
        jobs.map((job) => (
          <Card key={job.id} className="overflow-hidden">
            <button
              onClick={() => toggleExpand(job)}
              className="flex w-full items-start gap-3 p-4 text-left hover:bg-secondary/40"
            >
              <Send className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={cn("text-xs", JOB_STATUS_COLOR[job.status])}>
                    {job.status}
                  </Badge>
                  <span className="text-sm font-medium text-foreground">
                    {job.templateName ? `Template: ${job.templateName}` : "Free text"}
                  </span>
                  <span className="text-xs text-muted-foreground">via {job.numberLabel}</span>
                  {/* Which Meta endpoint this job used. Only shown when it's
                      the Marketing Messages path, so existing Cloud API jobs
                      read exactly as they did before. */}
                  {job.usedMarketingApi && (
                    <Badge className="bg-violet-100 text-[10px] font-medium text-violet-700">
                      Marketing API
                    </Badge>
                  )}
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {job.templateName ? job.message || "(template body)" : job.message}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span>{job.createdByName} · {formatDateTime(job.createdAt)}</span>
                  <span className="inline-flex items-center gap-1 text-emerald-600">
                    <Check className="h-3 w-3" /> {job.sentCount} sent
                  </span>
                  {job.failedCount > 0 && (
                    <span className="inline-flex items-center gap-1 text-destructive">
                      <AlertTriangle className="h-3 w-3" /> {job.failedCount} failed
                    </span>
                  )}
                  <span>{job.cursor}/{job.totalCount} processed</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {canDelete && (job.status === "completed" || job.status === "cancelled" || job.status === "failed") && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); setDeleteTarget(job); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setDeleteTarget(job); } }}
                    title="Delete this trigger from the status page"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </span>
                )}
                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-muted-foreground transition-transform",
                    expanded === job.id && "rotate-180",
                  )}
                />
              </div>
            </button>

            {expanded === job.id && (
              <div className="border-t border-border">
                {loadingRecipients ? (
                  <div className="flex justify-center py-8 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </div>
                ) : (
                  <>
                    {recipients.some((r) => r.status === "failed") && (
                      <div className="flex justify-end border-b border-border px-4 py-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadFailedRecipientsCsv(job, recipients)}
                          className="gap-1.5"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Download failed ({recipients.filter((r) => r.status === "failed").length}) as CSV
                        </Button>
                      </div>
                    )}
                    <div className="max-h-96 overflow-y-auto">
                      {recipients.map((r) => {
                        const s = RECIPIENT_STATUS[r.status];
                        return (
                          <div
                            key={r.guestId}
                            className="flex items-center gap-3 border-b border-border px-4 py-2 last:border-0"
                          >
                            <Badge className={cn("shrink-0 gap-1 text-xs", s.className)}>
                              <s.icon className="h-3 w-3" /> {s.label}
                            </Badge>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm text-foreground">
                                {r.guestName} <span className="text-muted-foreground">· {r.guestPhone ?? "no phone"}</span>
                              </div>
                              {r.errorDetail && (
                                <div className="truncate text-xs text-destructive">{r.errorDetail}</div>
                              )}
                            </div>
                            {r.sentAt && (
                              <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(r.sentAt)}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </Card>
        ))
      )}

      {deleteTarget && (
        <DeleteTriggerDialog
          job={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onDeleted={(id) => {
            setJobs((prev) => prev.filter((j) => j.id !== id));
            setDeleteTarget(null);
          }}
        />
      )}
    </div>
  );
}

function DeleteTriggerDialog({
  job,
  onCancel,
  onDeleted,
}: {
  job: BroadcastJobDTO;
  onCancel: () => void;
  onDeleted: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setDeleting(true);
    setError(null);
    try {
      await api.delete(`/api/broadcast-status/${job.id}`);
      onDeleted(job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete this trigger");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open onClose={onCancel} title="Delete this trigger?" className="md:max-w-sm">
      <div className="p-4 md:p-5">
        <p className="text-sm text-muted-foreground">
          Removes this trigger ({job.sentCount} sent, {job.failedCount} failed) from the Broadcast
          Status page only. It does not delete or hide any message from a guest&apos;s own WhatsApp
          conversation thread.
        </p>
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onCancel} disabled={deleting} className="w-full sm:w-auto">
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={deleting} className="w-full sm:w-auto">
            {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
            Delete trigger
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
