"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Send, Loader2, Trash2, ChevronDown, Check, X, Clock, AlertTriangle, Download, CalendarClock,
} from "lucide-react";
import { Card, Badge, Button, Dialog, Input, Textarea, Select } from "@/components/ui";
import { LibraryFileField, type LibraryFile } from "@/components/messaging/library-file-field";
import { templateNeedsHeaderImage, templateBodyParams } from "@/lib/whatsapp-template";
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
  numberId: string | null;
  delaySec: number;
  scheduledAt: string | null;
  followUpOfJobId: string | null;
  followUpRollingUntil: string | null;
  replyTag: string | null;
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
  const [followUpTarget, setFollowUpTarget] = useState<BroadcastJobDTO | null>(null);
  const [cancelTarget, setCancelTarget] = useState<BroadcastJobDTO | null>(null);

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
                  {job.followUpRollingUntil && job.status !== "completed" && job.status !== "cancelled" ? (
                    <span className="inline-flex items-center gap-1 font-medium text-brand-700">
                      <CalendarClock className="h-3 w-3" />
                      chasing each person until {formatIST(job.followUpRollingUntil, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  ) : job.scheduledAt && job.status === "queued" ? (
                    <span className="inline-flex items-center gap-1 font-medium text-brand-700">
                      <CalendarClock className="h-3 w-3" />
                      scheduled for {formatIST(job.scheduledAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  ) : null}
                  {job.followUpOfJobId && (
                    <Badge className="bg-indigo-100 text-[10px] text-indigo-800">follow-up</Badge>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {job.status === "completed" && job.sentCount > 0 && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); setFollowUpTarget(job); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setFollowUpTarget(job); } }}
                    title="Schedule a reminder to everyone who engaged, got the details, then went quiet"
                    className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
                  >
                    <CalendarClock className="h-4 w-4" /> Follow up
                  </span>
                )}
                {(job.status === "queued" || job.status === "running") && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); setCancelTarget(job); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setCancelTarget(job); } }}
                    title={job.scheduledAt ? "Call off this scheduled send" : "Stop this send"}
                    className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <X className="h-4 w-4" /> Cancel
                  </span>
                )}
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

      {followUpTarget && (
        <FollowUpDialog
          job={followUpTarget}
          onClose={() => setFollowUpTarget(null)}
          onScheduled={() => { setFollowUpTarget(null); load(); }}
        />
      )}

      {cancelTarget && (
        <CancelBroadcastDialog
          job={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onCancelled={() => { setCancelTarget(null); load(); }}
        />
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

/**
 * Calling off a queued or running send. Kept separate from DeleteTriggerDialog
 * because the two do opposite things: this one stops messages that haven't gone
 * out yet, while that one only clears a finished job off this page.
 */
function CancelBroadcastDialog({
  job,
  onClose,
  onCancelled,
}: {
  job: BroadcastJobDTO;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isRolling = Boolean(job.followUpRollingUntil);
  const isScheduled = isRolling || (Boolean(job.scheduledAt) && job.status === "queued");
  const isFollowUp = Boolean(job.followUpOfJobId);

  async function confirm() {
    setWorking(true);
    setError(null);
    try {
      await api.post(`/api/guests/broadcast/${job.id}/cancel`, {});
      onCancelled();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't cancel this send");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={isScheduled ? `Cancel this scheduled ${isFollowUp ? "follow-up" : "broadcast"}?` : "Stop this send?"}
      className="md:max-w-sm"
    >
      <div className="p-4 md:p-5">
        <p className="text-sm text-muted-foreground">
          {isRolling ? (
            <>
              Stops the chase for good. {job.sentCount > 0
                ? `${job.sentCount} ${job.sentCount === 1 ? "person has" : "people have"} already been reminded and cannot be recalled; nobody else will be.`
                : "Nobody has been reminded yet, so nobody will be."}
            </>
          ) : isScheduled ? (
            <>
              Nothing has been sent yet, so nobody will receive it. It stays on this page marked
              cancelled — this doesn&apos;t touch the campaign it follows up.
            </>
          ) : (
            <>
              {job.sentCount} of {job.totalCount} have already been messaged and those cannot be
              recalled. The remaining {Math.max(0, job.totalCount - job.cursor)} will not be sent.
            </>
          )}
        </p>
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={working} className="w-full sm:w-auto">
            Keep it
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={working} className="w-full sm:w-auto">
            {working && <Loader2 className="h-4 w-4 animate-spin" />}
            {isScheduled ? "Cancel it" : "Stop sending"}
          </Button>
        </div>
      </div>
    </Dialog>
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

interface FollowUpTemplate {
  name: string;
  language: string;
  status: string;
  category: string;
  components: { type: string; format?: string; text?: string }[];
}

interface FollowUpNumber {
  id: string;
  label: string;
  phoneNumber: string | null;
  status: string;
  isDefault: boolean;
  integration: string;
}

interface AudienceDTO {
  targeted: number;
  engaged: number;
  awaitingReply: number;
  recipients: number;
}

/**
 * Schedule the reminder that goes to guests who engaged with a campaign,
 * were sent the details, and then went quiet.
 *
 * The numbers shown are a PREVIEW, not the final list: recipients are
 * resolved again when the job actually starts, so anyone who replies or
 * calls during the wait drops out on their own. Said plainly in the dialog,
 * because "it'll send to 412 people" would otherwise read as a promise.
 */
function FollowUpDialog({
  job, onClose, onScheduled,
}: {
  job: BroadcastJobDTO;
  onClose: () => void;
  onScheduled: () => void;
}) {
  const [audience, setAudience] = useState<AudienceDTO | null>(null);
  const [hours, setHours] = useState("48");
  const [trigger, setTrigger] = useState("");
  const [quietHours, setQuietHours] = useState("24");
  // "batch": one send at a fixed time. "rolling": chase each guest on their
  // own clock. In rolling mode the quiet window IS the per-guest delay —
  // "we spoke last and it's been N hours" is exactly "N hours after our last
  // message to them" — so the two inputs collapse into one.
  const [mode, setMode] = useState<"batch" | "rolling">("batch");
  const [perPersonHours, setPerPersonHours] = useState("48");
  const [chaseDays, setChaseDays] = useState("14");
  // One number feeds both the preview and the send, so they can never disagree
  // about who qualifies. Blank falls back to the default rather than 0.
  const effectiveQuietHours =
    mode === "rolling" ? perPersonHours.trim() || "48" : quietHours.trim() || "24";
  const [message, setMessage] = useState("");
  const [numbers, setNumbers] = useState<FollowUpNumber[]>([]);
  // Always an explicit id — never "org default". A follow-up that silently
  // inherited the default went out on the wrong line: the org default here is
  // a QR-paired number, so a Cloud API campaign's reminder left from a
  // different phone than the campaign itself.
  const [numberId, setNumberId] = useState(job.numberId ?? "");
  const [templates, setTemplates] = useState<FollowUpTemplate[] | null>(null);
  const [templateName, setTemplateName] = useState(job.templateName ?? "");
  const [replyTag, setReplyTag] = useState(job.replyTag ?? "");
  // A template with an IMAGE header, or {{…}} placeholders in its body, can
  // only be sent WITH them — Meta rejects the whole message with a 400
  // otherwise, which is exactly what happened before these were collected.
  const [headerImage, setHeaderImage] = useState<LibraryFile | null>(null);
  const [headerImageId, setHeaderImageId] = useState<string | null>(null);
  const [templateParams, setTemplateParams] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-previews as the filters change, so the count on screen always matches
  // the settings about to be saved.
  useEffect(() => {
    const t = setTimeout(() => {
      setAudience(null);
      const qs = new URLSearchParams({ quietHours: effectiveQuietHours });
      if (trigger.trim()) qs.set("trigger", trigger.trim());
      api
        .get<AudienceDTO>(`/api/broadcast-status/${job.id}/followup-audience?${qs}`)
        .then(setAudience)
        .catch((e) => setError(e instanceof Error ? e.message : "Couldn't work out the audience"));
    }, 300);
    return () => clearTimeout(t);
  }, [job.id, trigger, effectiveQuietHours]);

  // Which lines are available to send from. Preselect the one the CAMPAIGN
  // used, so a reminder continues the same conversation thread by default.
  useEffect(() => {
    let cancelled = false;
    api
      .get<FollowUpNumber[]>("/api/admin/whatsapp/numbers")
      .then((nums) => {
        if (cancelled) return;
        const connected = nums.filter((n) => n.status === "connected");
        setNumbers(connected);
        setNumberId((cur) => cur || connected.find((n) => n.isDefault)?.id || connected[0]?.id || "");
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Approved templates belong to a specific Cloud API number, so this reloads
  // whenever the chosen line changes. A QR-paired number has none — an empty
  // list there is a fact, not a failure.
  useEffect(() => {
    let cancelled = false;
    const number = numbers.find((n) => n.id === numberId);
    if (!numberId || !number) return;
    if (number.integration !== "cloud_api") {
      setTemplates([]);
      setTemplateName("");
      return;
    }
    setTemplates(null);
    api
      .get<FollowUpTemplate[]>(`/api/admin/whatsapp/numbers/${numberId}/templates`)
      .then((list) => { if (!cancelled) setTemplates(list.filter((t) => t.status === "APPROVED")); })
      .catch(() => { if (!cancelled) setTemplates([]); });
    return () => { cancelled = true; };
  }, [numberId, numbers]);

  const sendAt = new Date(Date.now() + (parseFloat(hours) || 0) * 3600 * 1000);
  const chaseUntil = new Date(Date.now() + (parseFloat(chaseDays) || 14) * 86400 * 1000);
  const isTemplate = Boolean(templateName.trim());
  const chosenTemplate = templates?.find((t) => t.name === templateName) ?? null;
  const needsImage = chosenTemplate ? templateNeedsHeaderImage(chosenTemplate) : false;
  // The list didn't load (or the name was typed by hand), so we never saw this
  // template's components and cannot tell whether Meta wants a header image.
  // Treating "unknown" as "no image" is what silently dropped the header off a
  // follow-up on 2026-08-20: the Graph call that fetches the list is the same
  // one that was failing intermittently, and every failure quietly removed the
  // image requirement along with the field to satisfy it. Offer it instead and
  // say plainly that it is unverified.
  const templateUnverified = isTemplate && !chosenTemplate;
  const showImageField = needsImage || templateUnverified;
  const bodyParams = chosenTemplate
    ? templateBodyParams(chosenTemplate)
    : { names: [] as string[], isNamed: false };

  useEffect(() => {
    setTemplateParams(Array(bodyParams.names.length).fill(""));
    // Keeps an attachment while the template is unverified — clearing it there
    // would throw away the only thing that can make the send succeed.
    if (!showImageField) { setHeaderImage(null); setHeaderImageId(null); }
    // Keyed on the template itself: switching templates invalidates values
    // collected for the previous one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateName, bodyParams.names.length, showImageField]);

  // Meta refuses the send outright if these are missing, so the button is
  // disabled rather than letting it fail 48 hours later with nobody watching.
  const missingTemplateInputs =
    isTemplate && (
      (needsImage && !headerImageId) ||
      templateParams.some((v, i) => i < bodyParams.names.length && !v.trim())
    );

  async function schedule() {
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/guests/broadcast", {
        followUpOfJobId: job.id,
        message: isTemplate ? "" : message.trim(),
        template: isTemplate
          ? {
              name: templateName.trim(),
              // The template's own language, not a guess — Meta rejects a
              // send whose language doesn't match the approved template.
              language: chosenTemplate?.language ?? "en",
              bodyParams: templateParams.slice(0, bodyParams.names.length),
              bodyParamNames: bodyParams.isNamed ? bodyParams.names : undefined,
            }
          : undefined,
        imageDocumentId: headerImageId ?? undefined,
        numberId: numberId || undefined,
        delaySec: job.delaySec,
        // Rolling starts checking immediately: anyone already past their own
        // delay should be messaged now, not one batch-delay from now.
        scheduledAt: (mode === "rolling" ? new Date() : sendAt).toISOString(),
        followUpRollingUntil: mode === "rolling" ? chaseUntil.toISOString() : undefined,
        followUpTrigger: trigger.trim() || undefined,
        // Blank must mean "use the default", not 0 — `|| 0` turned an empty box
        // into an explicit zero (no quiet window at all) while the preview
        // substituted 24, so the send reached people the preview had filtered
        // out. This is the same value the preview used.
        followUpQuietHours: parseInt(effectiveQuietHours, 10),
        replyTag: replyTag.trim() || undefined,
      });
      onScheduled();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't schedule the follow-up");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="Schedule a follow-up" className="md:max-w-lg">
      <div className="space-y-3 p-4 md:p-5">
        <div className="rounded-lg border border-border bg-secondary/40 p-3 text-xs">
          {!audience ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working out who to send to…
            </span>
          ) : (
            <div className="space-y-1">
              <Row label="Originally messaged" value={audience.targeted} />
              <Row label={trigger.trim() ? `Tapped "${trigger.trim()}"` : "Came back to us"} value={audience.engaged} />
              <Row label="…of those, we replied and they went quiet" value={audience.awaitingReply} />
              <div className="mt-1.5 flex items-center justify-between border-t border-border pt-1.5 font-semibold text-foreground">
                <span>Would get the reminder if it sent now</span>
                <span>{audience.recipients}</span>
              </div>
              {audience.recipients === 0 && (
                <p className="pt-1 text-[11px] text-amber-600 dark:text-amber-500">
                  Nobody qualifies yet — normal this early, since people have to reply and be
                  answered first. Scheduling is still worth doing: the list is worked out when
                  the follow-up runs, not now.
                  {mode === "batch"
                    ? " It runs once, so pick a time by which most replies will have been answered."
                    : " Each person is picked up as they come due, so an empty list now is expected."}
                </p>
              )}
            </div>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground">
          Goes only to people who engaged and were sent the details — never to those who
          ignored the campaign entirely. Anyone who replies on WhatsApp <em>or phones us</em>
          before this runs is dropped automatically; the list is rebuilt when it sends, so
          these numbers will shift.
        </p>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Only people who tapped (optional)</span>
          <Input
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
            placeholder="e.g. Enquire Now"
          />
          <span className="block text-[11px] text-muted-foreground">
            The button&apos;s exact label. Leave blank to include everyone who came back to
            us — by button, chat, or phone.
          </span>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">When to send</span>
          <Select value={mode} onChange={(e) => setMode(e.target.value as "batch" | "rolling")}>
            <option value="batch">One batch, at a set time</option>
            <option value="rolling">Each person, on their own clock</option>
          </Select>
          <span className="block text-[11px] text-muted-foreground">
            {mode === "batch"
              ? "Everyone eligible at that moment is messaged together. It runs once — anyone who becomes eligible later gets nothing."
              : "Each person is messaged once, as soon as they personally hit the delay below. Someone we last wrote to at 2pm is reminded at 2pm, someone at 3pm at 3pm."}
          </span>
        </label>

        {mode === "batch" ? (
          <>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Skip if we&apos;ve messaged them within (hours)</span>
              <Input type="number" min={0} max={720} value={quietHours} onChange={(e) => setQuietHours(e.target.value)} />
              <span className="block text-[11px] text-muted-foreground">
                Stops the reminder talking over a rep who is mid-conversation. Keep this
                well below the send delay — set to 48 on a 48-hour send, anyone messaged
                even minutes later falls short and, because this runs once, never gets it.
              </span>
            </label>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Send in (hours)</span>
              <Input type="number" min={1} max={720} value={hours} onChange={(e) => setHours(e.target.value)} />
              <span className="block text-[11px] text-muted-foreground">
                ≈ {formatIST(sendAt, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} IST
              </span>
            </label>
          </>
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Remind each person (hours after our last message to them)</span>
              <Input type="number" min={1} max={720} value={perPersonHours} onChange={(e) => setPerPersonHours(e.target.value)} />
              <span className="block text-[11px] text-muted-foreground">
                Doubles as the quiet window, so a rep who replies in the meantime resets
                that person&apos;s clock instead of being talked over. Checked every 15
                minutes, so a reminder lands within the hour it comes due.
              </span>
            </label>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Keep chasing for (days)</span>
              <Input type="number" min={1} max={90} value={chaseDays} onChange={(e) => setChaseDays(e.target.value)} />
              <span className="block text-[11px] text-muted-foreground">
                Stops {formatIST(chaseUntil, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} IST.
                Nobody is messaged twice, and anyone still unanswered when the window
                closes is simply left alone.
              </span>
            </label>
          </>
        )}

        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Send from</span>
          <Select value={numberId} onChange={(e) => setNumberId(e.target.value)}>
            {numbers.length === 0 && <option value="">Loading numbers…</option>}
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}{n.phoneNumber ? ` · ${n.phoneNumber}` : ""}
                {n.integration === "cloud_api" ? " · Cloud API" : " · QR-paired"}
                {n.id === job.numberId ? " (used by this campaign)" : ""}
              </option>
            ))}
          </Select>
          <span className="block text-[11px] text-muted-foreground">
            Defaults to the line the campaign went out on, so the reminder lands in the same
            chat. Only a Cloud API number can send an approved template past 24 hours.
          </span>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Approved template</span>
          {templates === null ? (
            <span className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading templates…
            </span>
          ) : templates.length === 0 ? (
            <>
              <Input
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="e.g. raksha26_reminder"
              />
              <span className="block text-[11px] text-muted-foreground">
                Couldn&apos;t load templates for this number — type the approved name exactly, or
                leave blank to send free text from a QR-paired number.
              </span>
            </>
          ) : (
            <>
              <Select value={templateName} onChange={(e) => setTemplateName(e.target.value)}>
                <option value="">Free text (QR-paired numbers only)</option>
                {templates.map((t) => (
                  <option key={`${t.name}:${t.language}`} value={t.name}>
                    {t.name} · {t.language}{t.category ? ` · ${t.category}` : ""}
                  </option>
                ))}
              </Select>
              <span className="block text-[11px] text-muted-foreground">
                Past 24 hours WhatsApp blocks free text on the Cloud API number, so a reminder
                has to use an approved template.
              </span>
            </>
          )}
        </label>

        {showImageField && (
          <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              Header image {needsImage ? "(required)" : "(required if this template has an image header)"}
            </span>
            <LibraryFileField
              attachment={headerImage}
              onChange={(id, file) => { setHeaderImageId(id); setHeaderImage(file); }}
            />
            <span className="block text-[11px] text-muted-foreground">
              {needsImage
                ? "This template was approved with an image header, so Meta rejects the send without one."
                : "Couldn't read this template's definition, so we can't tell whether it needs one. Attach the image if it does — Meta rejects the send either way if this doesn't match the approved template."}
            </span>
          </div>
        )}

        {bodyParams.names.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Template values</span>
            {bodyParams.names.map((name, i) => (
              <label key={name} className="block space-y-1">
                <span className="text-[11px] text-muted-foreground">
                  {bodyParams.isNamed ? `{{${name}}}` : `Value ${name}`}
                </span>
                <Input
                  value={templateParams[i] ?? ""}
                  onChange={(e) =>
                    setTemplateParams((prev) => {
                      const next = [...prev];
                      next[i] = e.target.value;
                      return next;
                    })
                  }
                  placeholder="{name} and {salutation} are filled in per guest"
                />
              </label>
            ))}
          </div>
        )}

        {!isTemplate && (
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Message</span>
            <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
        )}

        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Reply tag (optional)</span>
          <Input value={replyTag} onChange={(e) => setReplyTag(e.target.value)} placeholder="e.g. raksha-reminder" />
        </label>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            onClick={schedule}
            disabled={
              saving
              || (!isTemplate && !message.trim())
              || missingTemplateInputs
            }
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Schedule
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={cn("flex items-center justify-between", muted && "text-muted-foreground")}>
      <span>{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
