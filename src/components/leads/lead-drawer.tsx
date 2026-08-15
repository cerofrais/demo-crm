"use client";

import { useEffect, useRef, useState } from "react";
import { X, Clock, Calendar, MessageSquare, FileText, FolderOpen, Mail, MessageCircle, Loader2, Plus, Phone, Sparkles, Trash2, Ban, Paperclip, Download, CheckCircle2, XCircle } from "lucide-react";
import { Button, Input, Select, Textarea, Badge, Sheet, Dialog, ScrollableTabs, type TabItem } from "@/components/ui";
import { AudioRecordButton } from "@/components/ui/audio-record-button";
import { STAGES, STAGE_MAP } from "@/lib/kanban";
import { api } from "@/lib/client";
import { cn, formatINR, formatIST } from "@/lib/utils";
import { formatTag, sortTags, isSystemTag } from "@/lib/lead-tags";
import { validateIndianPhone } from "@/lib/validation";
import { DocumentManager } from "@/components/documents/document-manager";
import { ConversationPanel } from "@/components/conversation/conversation-panel";
import { WhatsAppPanel } from "@/components/whatsapp/whatsapp-panel";
import { CallButton } from "@/components/calls/call-button";
import { WhatsAppCallButton } from "@/components/calls/whatsapp-call-button";
import { CallsPanel } from "@/components/calls/calls-panel";
import { AssistPanel } from "@/components/ai/assist-panel";
import { OwnerPicker } from "@/components/leads/owner-picker";
import type { EnquiryDTO, TimelineItemDTO } from "@/lib/types";
import type { EnquiryStage } from "@prisma/client";
import { useRouter } from "next/navigation";

type Tab = "details" | "remarks" | "conversation" | "whatsapp" | "calls" | "ai" | "documents" | "activity";

/** Local (not UTC) date/time parts for <input type="date">/<input type="time"> defaults. */
function localDateTimeParts(d: Date): { date: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Default the picker to an hour from now — matches the old default (amount=1, unit=hours). */
function defaultTaskDateTime(): { date: string; time: string } {
  return localDateTimeParts(new Date(Date.now() + 60 * 60 * 1000));
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function LeadDrawer({
  enquiry,
  canManage,
  canWorkLeads,
  canDelete = false,
  canDoctorDecide = false,
  isAdmin = false,
  onClose,
  onUpdated,
  onDeleted,
  initialTab,
}: {
  enquiry: EnquiryDTO | null;
  /** Open straight onto a tab — the notification dropdown sends you to the
   *  channel the new message arrived on, not to Details. */
  initialTab?: Tab;
  canManage: boolean;
  /** Can mutate this lead at all — field edits, remarks, tasks, tags. False
   *  for a read-only Viewer. */
  canWorkLeads: boolean;
  canDelete?: boolean;
  canDoctorDecide?: boolean;
  /** The Staff stage is Admin-only — hides it from the Stage dropdown for
   *  everyone else, including Manager. */
  isAdmin?: boolean;
  onClose: () => void;
  onUpdated: (e: EnquiryDTO) => void;
  onDeleted?: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("details");
  const [timeline, setTimeline] = useState<TimelineItemDTO[]>([]);
  const [loadingTl, setLoadingTl] = useState(false);
  const [remark, setRemark] = useState("");
  const [remarkAttachment, setRemarkAttachment] = useState<File | null>(null);
  const [remarkUploadCategory, setRemarkUploadCategory] = useState<string | null>(null);
  const remarkFileRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState<"soft" | "hard" | null>(null);
  const [form, setForm] = useState({
    fullName: "",
    phone: "",
    email: "",
    city: "",
    quotedPriceINR: "",
    stage: "new_lead" as EnquiryStage,
    intakeNotes: "",
    preferredCheckIn: "",
  });
  const [vocab, setVocab] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  // Mutation errors are surfaced inline — without these a 403/409/network
  // failure just stopped the spinner and looked exactly like a success.
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [remarkError, setRemarkError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDate, setTaskDate] = useState(() => defaultTaskDateTime().date);
  const [taskTime, setTaskTime] = useState(() => defaultTaskDateTime().time);
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [doctorDeciding, setDoctorDeciding] = useState<string | null>(null);
  const [doctorDecisionError, setDoctorDecisionError] = useState<string | null>(null);
  const [requestingLost, setRequestingLost] = useState(false);
  const [requestLostError, setRequestLostError] = useState<string | null>(null);

  useEffect(() => {
    if (!enquiry) return;
    // Whatever the opener asked for, else back to Details for a fresh open.
    setTab(initialTab ?? "details");
    setDetailsError(null);
    setRemarkError(null);
    setDeleteError(null);
    setForm({
      fullName: enquiry.guest.fullName ?? "",
      phone: enquiry.guest.phone ?? "",
      email: enquiry.guest.email ?? "",
      city: enquiry.guest.city ?? "",
      quotedPriceINR: enquiry.quotedPriceINR?.toString() ?? "",
      stage: enquiry.stage,
      intakeNotes: enquiry.intakeNotes ?? "",
      // Stored at UTC midnight for the guest's calendar date, so slicing the
      // ISO string gives the <input type="date"> value back unchanged. Going
      // via local time here would shift it a day for anyone west of UTC.
      preferredCheckIn: enquiry.preferredCheckIn?.slice(0, 10) ?? "",
    });
    // Clear the attention flag as soon as a rep opens the drawer.
    if (enquiry.needsAttention && canWorkLeads) {
      api
        .patch<EnquiryDTO>(`/api/enquiries/${enquiry.id}`, { needsAttention: false })
        .then(onUpdated)
        .catch(() => null);
    }
  }, [enquiry?.id, initialTab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.get<string[]>("/api/tags").then(setVocab).catch(() => {});
  }, []);

  useEffect(() => {
    api
      .get<{ uploadable: string[] }>("/api/files/meta")
      .then((m) => setRemarkUploadCategory(m.uploadable.includes("operational") ? "operational" : (m.uploadable[0] ?? null)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!enquiry || tab !== "activity") return;
    setLoadingTl(true);
    api
      .get<TimelineItemDTO[]>(`/api/enquiries/${enquiry.id}/timeline`)
      .then(setTimeline)
      .finally(() => setLoadingTl(false));
  }, [enquiry, tab]);

  if (!enquiry) return null;

  async function saveDetails() {
    if (!enquiry) return;
    const pErr = validateIndianPhone(form.phone);
    if (pErr) { setPhoneError(pErr); return; }
    setPhoneError(null);
    setDetailsError(null);
    setSaving(true);
    try {
      const updated = await api.patch<EnquiryDTO>(`/api/enquiries/${enquiry.id}`, {
        fullName: form.fullName,
        phone: form.phone,
        email: form.email,
        city: form.city,
        quotedPriceINR: form.quotedPriceINR ? Number(form.quotedPriceINR) : null,
        stage: form.stage,
        intakeNotes: form.intakeNotes,
        // "" clears the date; the schema maps it to null.
        preferredCheckIn: form.preferredCheckIn,
      });
      onUpdated(updated);
    } catch (e) {
      setDetailsError(errorMessage(e, "Couldn't save changes. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  async function recordDoctorDecision(decision: "accepted" | "rejected" | "needs_phone_consult") {
    if (!enquiry) return;
    setDoctorDecisionError(null);
    setDoctorDeciding(decision);
    try {
      const updated = await api.patch<EnquiryDTO>(`/api/enquiries/${enquiry.id}/doctor-decision`, {
        decision,
      });
      onUpdated(updated);
    } catch (e) {
      setDoctorDecisionError(errorMessage(e, "Couldn't record the decision. Please try again."));
    } finally {
      setDoctorDeciding(null);
    }
  }

  async function requestLost() {
    if (!enquiry) return;
    setRequestLostError(null);
    setRequestingLost(true);
    try {
      const updated = await api.post<EnquiryDTO>(`/api/enquiries/${enquiry.id}/request-lost`, {});
      onUpdated(updated);
    } catch (e) {
      setRequestLostError(errorMessage(e, "Couldn't send the request. Please try again."));
    } finally {
      setRequestingLost(false);
    }
  }

  async function addRemark() {
    if (!enquiry || (!remark.trim() && !remarkAttachment)) return;
    setRemarkError(null);
    setSaving(true);
    try {
      let attachmentDocumentId: string | undefined;
      if (remarkAttachment && remarkUploadCategory) {
        const guestId = enquiry.guest.id;
        const { url, storageKey } = await api.post<{ url: string; storageKey: string }>(
          "/api/files/upload-url",
          {
            filename: remarkAttachment.name,
            mimeType: remarkAttachment.type || "application/octet-stream",
            category: remarkUploadCategory,
            sizeBytes: remarkAttachment.size,
            guestId,
            enquiryId: enquiry.id,
          },
        );
        const put = await fetch(url, {
          method: "PUT",
          body: remarkAttachment,
          headers: { "Content-Type": remarkAttachment.type || "application/octet-stream" },
        });
        if (!put.ok) throw new Error(`Attachment upload failed (${put.status})`);
        const confirmed = await api.post<{ id: string }>("/api/files/confirm", {
          storageKey,
          filename: remarkAttachment.name,
          mimeType: remarkAttachment.type || "application/octet-stream",
          category: remarkUploadCategory,
          sizeBytes: remarkAttachment.size,
          guestId,
          enquiryId: enquiry.id,
        });
        attachmentDocumentId = confirmed.id;
      }
      await api.post(`/api/enquiries/${enquiry.id}/notes`, { body: remark, attachmentDocumentId });
      setRemark("");
      setRemarkAttachment(null);
      if (remarkFileRef.current) remarkFileRef.current.value = "";
      if (tab === "activity") {
        const tl = await api.get<TimelineItemDTO[]>(`/api/enquiries/${enquiry.id}/timeline`);
        setTimeline(tl);
      }
    } catch (e) {
      setRemarkError(errorMessage(e, "Couldn't add the remark. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  async function addTask() {
    if (!enquiry || !taskTitle.trim() || !taskDate || !taskTime) return;
    setTaskError(null);

    // The API still speaks "amount N hours/days from now" — this only
    // changes how staff pick the due time, not the task-creation contract.
    const dueAt = new Date(`${taskDate}T${taskTime}`);
    const diffMs = dueAt.getTime() - Date.now();
    if (!Number.isFinite(dueAt.getTime()) || diffMs <= 0) {
      setTaskError("Pick a date and time in the future.");
      return;
    }
    const diffHours = Math.round(diffMs / (60 * 60 * 1000));
    const amount = diffHours <= 365 ? Math.max(1, diffHours) : Math.min(365, Math.round(diffMs / (24 * 60 * 60 * 1000)));
    const unit: "hours" | "days" = diffHours <= 365 ? "hours" : "days";

    setTaskSaving(true);
    try {
      await api.post(`/api/enquiries/${enquiry.id}/tasks`, {
        title: taskTitle,
        amount,
        unit,
      });
      setTaskTitle("");
      const next = defaultTaskDateTime();
      setTaskDate(next.date);
      setTaskTime(next.time);
      if (tab === "activity") {
        const tl = await api.get<TimelineItemDTO[]>(`/api/enquiries/${enquiry.id}/timeline`);
        setTimeline(tl);
      }
    } catch (e) {
      setTaskError(errorMessage(e, "Couldn't add the task. Please try again."));
    } finally {
      setTaskSaving(false);
    }
  }

  async function addTag(value: string) {
    const v = value.trim();
    if (!v || !enquiry) return;
    setTagBusy(true);
    try {
      const updated = await api.patch<EnquiryDTO>(
        `/api/enquiries/${enquiry.id}/tags`,
        { add: v },
      );
      onUpdated(updated);
      setTagInput("");
      api.get<string[]>("/api/tags").then(setVocab).catch(() => {});
    } finally {
      setTagBusy(false);
    }
  }

  async function removeTag(value: string) {
    if (!enquiry) return;
    const updated = await api.patch<EnquiryDTO>(
      `/api/enquiries/${enquiry.id}/tags`,
      { remove: value },
    );
    onUpdated(updated);
  }

  async function deleteLead(mode: "soft" | "hard") {
    if (!enquiry) return;
    setDeleteError(null);
    setDeleting(mode);
    try {
      await api.delete(`/api/enquiries/${enquiry.id}?mode=${mode}`);
      setConfirmingDelete(false);
      onDeleted?.(enquiry.id);
      onClose();
    } catch (e) {
      // Keep the dialog open on failure so the user sees why nothing happened.
      setDeleteError(errorMessage(e, "Couldn't delete this lead. Please try again."));
    } finally {
      setDeleting(null);
    }
  }

  const g = enquiry.guest;
  const stageDef = STAGE_MAP[enquiry.stage];

  const TABS: TabItem[] = [
    { key: "details", label: "Details", icon: <FileText className="h-4 w-4" /> },
    { key: "remarks", label: "Add Remark", icon: <MessageSquare className="h-4 w-4" /> },
    { key: "calls", label: "Calls", icon: <Phone className="h-4 w-4" /> },
    { key: "conversation", label: "Email", icon: <Mail className="h-4 w-4" /> },
    { key: "whatsapp", label: "WhatsApp", icon: <MessageCircle className="h-4 w-4" /> },
    { key: "ai", label: "AI Assist", icon: <Sparkles className="h-4 w-4" /> },
    { key: "documents", label: "Documents", icon: <FolderOpen className="h-4 w-4" /> },
    { key: "activity", label: "Activity", icon: <Clock className="h-4 w-4" /> },
  ];

  return (
    <>
    <Sheet
      open
      onClose={onClose}
      side="right"
      widthClassName="w-full max-w-3xl"
      scrollBody={false}
      ariaLabel={`Lead: ${g.fullName}`}
    >
      {/* Header */}
      <div className="flex shrink-0 items-start justify-between border-b border-border px-4 py-4 md:px-6">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-foreground">{g.fullName}</h2>
          <p className="text-sm text-muted-foreground">
            {g.phone}
            {g.isReturning && (
              <Badge className="ml-2 bg-brand-100 text-brand-700">Returning guest</Badge>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CallButton
            guestId={g.id}
            enquiryId={enquiry.id}
            customerPhone={g.phone ?? null}
          />
          <WhatsAppCallButton enquiryId={enquiry.id} customerPhone={g.phone ?? null} />
          {canWorkLeads && enquiry.stage !== "lost" && (
            enquiry.lostRequestPending ? (
              <Button
                variant="outline"
                size="sm"
                disabled
                title="Waiting on an Admin/Manager to approve or deny"
                className="text-muted-foreground"
              >
                <Ban className="h-3.5 w-3.5" /> Pending approval
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={requestLost}
                disabled={requestingLost}
                title="Request this lead be marked Lost/Dead — an Admin/Manager will need to approve it"
                className="text-destructive hover:bg-destructive/10"
              >
                {requestingLost ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                Lost/Dead
              </Button>
            )
          )}
          {canDelete && (
            <button
              onClick={() => {
                setDeleteError(null);
                setConfirmingDelete(true);
              }}
              aria-label="Delete lead"
              title="Delete lead"
              className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive lg:h-9 lg:w-9"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-secondary lg:h-9 lg:w-9"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Returning banner */}
      {(g.isReturning || enquiry.isReturningFlag) && (
        <div className="shrink-0 border-b border-brand-200 bg-brand-50 px-4 py-2 text-sm text-brand-800 md:px-6">
          Previously visited — health & preference history is on file. Confirm
          contact details only.
        </div>
      )}

      {requestLostError && (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive md:px-6">
          {requestLostError}
        </div>
      )}

      {/* Tabs */}
      <div className="shrink-0">
        <ScrollableTabs tabs={TABS} active={tab} onChange={(k) => setTab(k as Tab)} />
      </div>

      {/* Body — conversation/whatsapp fill height (scroll internally); other tabs scroll here */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "conversation" || tab === "whatsapp" ? (
          // Match the other tabs' gutters — the chat panels bring no padding of
          // their own, so without this the thread border and composer sit flush
          // against the drawer walls. `h-full` stays so they still fill and
          // scroll internally.
          <div className="h-full px-4 py-4 md:px-6">
            {tab === "conversation" ? (
              <ConversationPanel
                guestId={enquiry.guest.id}
                guestName={enquiry.guest.fullName}
                guestGender={enquiry.guest.gender}
                enquiryId={enquiry.id}
              />
            ) : (
              <WhatsAppPanel
                guestId={enquiry.guest.id}
                guestName={enquiry.guest.fullName}
                guestGender={enquiry.guest.gender}
                enquiryId={enquiry.id}
              />
            )}
          </div>
        ) : (
          <div className="h-full overflow-y-auto px-4 py-4 md:px-6">
          {tab === "details" && (
            <div className="space-y-4">
              {enquiry.doctorDecision ? (
                <div
                  className={cn(
                    "rounded-md border p-3",
                    enquiry.doctorDecision === "accepted"
                      ? "border-brand-200 bg-brand-50"
                      : enquiry.doctorDecision === "rejected"
                        ? "border-rose-200 bg-rose-50"
                        : "border-amber-200 bg-amber-50",
                  )}
                >
                  <p
                    className={cn(
                      "text-sm",
                      enquiry.doctorDecision === "accepted"
                        ? "text-brand-800"
                        : enquiry.doctorDecision === "rejected"
                          ? "text-rose-800"
                          : "text-amber-800",
                    )}
                  >
                    <span className="font-medium">
                      Doctor:{" "}
                      {enquiry.doctorDecision === "accepted"
                        ? "Accepted"
                        : enquiry.doctorDecision === "rejected"
                          ? "Rejected"
                          : "Needs phone consult"}
                    </span>
                    {enquiry.doctorDecisionAt && (
                      <span className="opacity-80">
                        {" "}
                        — {formatIST(enquiry.doctorDecisionAt, {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    )}
                  </p>
                  {enquiry.doctorDecisionNote && (
                    <p className="mt-1 text-xs opacity-80">{enquiry.doctorDecisionNote}</p>
                  )}
                </div>
              ) : (
                canDoctorDecide &&
                enquiry.stage === "doctor_consultation" && (
                  <div className="rounded-md border border-indigo-200 bg-indigo-50 p-3">
                    <p className="mb-2 text-sm font-medium text-indigo-900">
                      Doctor consultation decision
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => recordDoctorDecision("accepted")}
                        disabled={doctorDeciding !== null}
                      >
                        {doctorDeciding === "accepted" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => recordDoctorDecision("rejected")}
                        disabled={doctorDeciding !== null}
                      >
                        {doctorDeciding === "rejected" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => recordDoctorDecision("needs_phone_consult")}
                        disabled={doctorDeciding !== null}
                      >
                        {doctorDeciding === "needs_phone_consult" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        Needs Phone Consult
                      </Button>
                    </div>
                    {doctorDecisionError && (
                      <p className="mt-2 text-xs text-destructive">{doctorDecisionError}</p>
                    )}
                  </div>
                )
              )}
              <Field label="Stage">
                <Select
                  value={form.stage}
                  disabled={!canManage}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, stage: e.target.value as EnquiryStage }))
                  }
                >
                  {/* Lost/Dead is request-only now (see the header button) — not a
                      directly-selectable target, but still shown if the lead is
                      already there, so this dropdown can still move it out. Staff
                      is Admin-only, same reasoning (Manager can still move a lead
                      out of it if one somehow ended up there). */}
                  {STAGES.filter(
                    (s) =>
                      (s.id !== "lost" || form.stage === "lost") &&
                      (s.id !== "staff" || isAdmin || form.stage === "staff"),
                  ).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Owner">
                <OwnerPicker
                  enquiryId={enquiry.id}
                  assignedToSub={enquiry.assignedToSub}
                  assignedToName={enquiry.assignedToName}
                  canManage={canManage}
                  onUpdated={onUpdated}
                />
              </Field>
              <Field label="Full name">
                <Input
                  value={form.fullName}
                  disabled={!canWorkLeads}
                  onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
                />
              </Field>
              <Field label="Phone">
                <Input
                  value={form.phone}
                  disabled={!canWorkLeads}
                  onChange={(e) => {
                    const v = e.target.value;
                    setForm((f) => ({ ...f, phone: v }));
                    setPhoneError(validateIndianPhone(v));
                  }}
                  placeholder="+919876543210"
                  className={phoneError ? "border-destructive focus-visible:ring-destructive" : ""}
                />
                {phoneError && (
                  <p className="mt-1 text-xs text-destructive">{phoneError}</p>
                )}
              </Field>

              <div className="space-y-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Tags
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {sortTags(enquiry.tags).map((t) => {
                    const f = formatTag(t);
                    const sys = isSystemTag(t);
                    return (
                      <span
                        key={t}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                          f.className,
                        )}
                      >
                        {f.label}
                        {!sys && canWorkLeads && (
                          <button
                            onClick={() => removeTag(t)}
                            // -my-1/-mr-1 pull the padding back out of the
                            // layout so the tap area grows without the chip
                            // visually bloating.
                            className="-my-1 -mr-1 flex items-center justify-center p-1.5 hover:opacity-60"
                            title="Remove tag"
                            aria-label={`Remove tag ${f.label}`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </span>
                    );
                  })}
                  {enquiry.tags.length === 0 && (
                    <span className="text-xs text-muted-foreground">No tags yet.</span>
                  )}
                </div>
                {canWorkLeads && (
                  <div className="flex gap-2">
                    <Input
                      list="tre-tag-vocab"
                      value={tagInput}
                      placeholder="Add a tag (e.g. high-intent)…"
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addTag(tagInput);
                        }
                      }}
                    />
                    <datalist id="tre-tag-vocab">
                      {vocab.map((v) => (
                        <option key={v} value={v} />
                      ))}
                    </datalist>
                    <Button
                      variant="outline"
                      onClick={() => addTag(tagInput)}
                      disabled={tagBusy || !tagInput.trim()}
                    >
                      {tagBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                      Add
                    </Button>
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Age, source &amp; revisit are auto-tagged. New tags you add become
                  available to everyone.
                </p>
              </div>
              <Field label="Email">
                <Input
                  value={form.email}
                  disabled={!canWorkLeads}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                />
              </Field>
              <Field label="City">
                <Input
                  value={form.city}
                  disabled={!canWorkLeads}
                  onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                />
              </Field>
              <Field label="Preferred check-in">
                <Input
                  type="date"
                  value={form.preferredCheckIn}
                  disabled={!canWorkLeads}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, preferredCheckIn: e.target.value }))
                  }
                />
              </Field>
              <Field label="Quoted price (INR)">
                <Input
                  type="number"
                  value={form.quotedPriceINR}
                  placeholder="e.g. 98000"
                  disabled={!canWorkLeads}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, quotedPriceINR: e.target.value }))
                  }
                />
              </Field>
              <Field label="Notes">
                <Textarea
                  value={form.intakeNotes}
                  placeholder="Optional — context captured at intake (e.g. lead form answers) or anything else worth keeping on the ticket itself, separate from the remarks timeline."
                  disabled={!canWorkLeads}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, intakeNotes: e.target.value }))
                  }
                  className="min-h-[80px]"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3 rounded-lg bg-secondary/50 p-3 text-sm">
                <Meta label="Source" value={enquiry.source} />
                <Meta label="Age group" value={g.ageGroup ?? "—"} />
                <Meta label="Gender" value={g.gender ?? "—"} />
                <Meta label="Current quote" value={formatINR(enquiry.quotedPriceINR)} />
                <Meta
                  label="Preferred check-in"
                  value={
                    enquiry.preferredCheckIn
                      ? formatIST(enquiry.preferredCheckIn, { dateStyle: "medium" })
                      : "—"
                  }
                />
              </div>
              {detailsError && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {detailsError}
                </div>
              )}
              {canWorkLeads && (
                <Button onClick={saveDetails} disabled={saving} className="w-full">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save changes
                </Button>
              )}
            </div>
          )}

          {tab === "remarks" && (
            <div className="space-y-3">
              {canWorkLeads ? (
                <>
                  <Textarea
                    placeholder="Add a remark (e.g. spoke to lead, shared pricing on WhatsApp)…"
                    value={remark}
                    onChange={(e) => setRemark(e.target.value)}
                  />
                  {remarkAttachment && (
                    <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 px-2.5 py-1.5 text-xs">
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{remarkAttachment.name}</span>
                      <span className="shrink-0 text-muted-foreground">{humanSize(remarkAttachment.size)}</span>
                      <button
                        onClick={() => { setRemarkAttachment(null); if (remarkFileRef.current) remarkFileRef.current.value = ""; }}
                        className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                        title="Remove attachment"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  {remarkError && (
                    <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {remarkError}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <input
                      ref={remarkFileRef}
                      type="file"
                      className="hidden"
                      onChange={(e) => setRemarkAttachment(e.target.files?.[0] ?? null)}
                    />
                    {remarkUploadCategory && (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => remarkFileRef.current?.click()}
                        disabled={saving || Boolean(remarkAttachment)}
                        title="Attach a file to this remark"
                      >
                        <Paperclip className="h-4 w-4" />
                      </Button>
                    )}
                    {remarkUploadCategory && !remarkAttachment && (
                      <AudioRecordButton disabled={saving} onRecorded={(file) => setRemarkAttachment(file)} />
                    )}
                    <Button onClick={addRemark} disabled={saving || (!remark.trim() && !remarkAttachment)} className="ml-auto">
                      {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                      Add remark
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Remarks are appended to the activity timeline for audit. Attach a voice note or file with the
                    mic/paperclip buttons.
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Read-only — you don&apos;t have permission to add remarks on this lead.
                </p>
              )}

              {canWorkLeads && enquiry?.stage !== "lost" && (
                <div className="space-y-2 border-t border-border pt-3">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Add a task
                  </span>
                  <Input
                    placeholder="Task (e.g. call back with revised pricing)…"
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Calendar className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        type="date"
                        value={taskDate}
                        onChange={(e) => setTaskDate(e.target.value)}
                        className="pl-8"
                      />
                    </div>
                    <div className="relative flex-1">
                      <Clock className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        type="time"
                        value={taskTime}
                        onChange={(e) => setTaskTime(e.target.value)}
                        className="pl-8"
                      />
                    </div>
                    <Button
                      variant="outline"
                      onClick={addTask}
                      disabled={taskSaving || !taskTitle.trim() || !taskDate || !taskTime}
                    >
                      {taskSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                      Add task
                    </Button>
                  </div>
                  {taskError && (
                    <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {taskError}
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Reminds you at the picked date &amp; time — shows up on the Tasks page.
                  </p>
                </div>
              )}
            </div>
          )}

          {tab === "calls" && (
            <CallsPanel guestId={enquiry.guest.id} enquiryId={enquiry.id} />
          )}

          {tab === "ai" && (
            <AssistPanel key={enquiry.id} enquiry={enquiry} onUpdated={onUpdated} />
          )}

          {tab === "documents" && (
            <DocumentManager
              scope={{ kind: "enquiry", enquiryId: enquiry.id }}
              compact
            />
          )}

          {tab === "activity" && (
            <div className="space-y-3">
              {loadingTl && (
                <div className="flex justify-center py-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              )}
              {!loadingTl && timeline.length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No activity yet.
                </p>
              )}
              {timeline.map((item) => {
                const isAdminNote = item.kind === "note" && item.actorRole === "ADMIN";
                // "Task created/completed/cancelled" entries all carry the
                // task's id in their metadata, so the timeline can hand you
                // straight to it rather than leaving you to find it in the
                // Tasks tab yourself.
                const taskId =
                  (item.actionType === "task_created" ||
                    item.actionType === "task_completed" ||
                    item.actionType === "task_cancelled") &&
                  typeof item.meta?.taskId === "string"
                    ? item.meta.taskId
                    : null;
                return (
                  <div
                    key={item.id}
                    onClick={taskId ? () => router.push(`/tasks?task=${taskId}`) : undefined}
                    title={taskId ? "Open this task in Tasks & Reminders" : undefined}
                    className={cn(
                      "rounded-lg border p-3",
                      isAdminNote
                        ? "border-indigo-200 bg-indigo-50/70"
                        : item.kind === "note"
                          ? "border-border bg-brand-50/60"
                          : "border-border",
                      taskId && "cursor-pointer transition-colors hover:border-brand-300 hover:bg-brand-50/40",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                        {item.actorName}
                        {isAdminNote && (
                          <Badge className="bg-indigo-100 text-indigo-700">Admin</Badge>
                        )}
                        {item.actionType === "task_completed" && (
                          <Badge className="flex items-center gap-1 bg-emerald-100 text-emerald-700">
                            <CheckCircle2 className="h-3 w-3" /> Done
                          </Badge>
                        )}
                        {item.actionType === "task_cancelled" && (
                          <Badge className="flex items-center gap-1 bg-muted text-muted-foreground">
                            <XCircle className="h-3 w-3" /> Cancelled
                          </Badge>
                        )}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatIST(item.createdAt, {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    {item.text && <p className="mt-0.5 text-sm text-muted-foreground">{item.text}</p>}
                    {item.attachment && <NoteAttachment attachment={item.attachment} />}
                  </div>
                );
              })}
            </div>
          )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-4 py-3 text-xs text-muted-foreground md:px-6">
        Stage: <span className="font-medium">{stageDef?.label}</span> · Created{" "}
        {formatIST(enquiry.createdAt, { dateStyle: "medium" })}
      </div>
    </Sheet>

    {/* The Dialog primitive owns Esc/Tab here. The old hand-rolled `fixed
        inset-0` div let Esc bubble to the Sheet's capture-phase listener, which
        closed the whole drawer (losing unsaved Details edits), and Tab walked
        into the drawer behind it. */}
    <Dialog
      open={confirmingDelete}
      onClose={() => setConfirmingDelete(false)}
      title="Delete lead"
      className="md:max-w-sm"
    >
        <div className="p-4 md:p-6">
          <p className="text-sm text-muted-foreground">
            How should {g.fullName}&apos;s lead be removed?
          </p>
          <div className="mt-3 space-y-2">
            <div className="rounded-md border border-border p-3 text-sm">
              <p className="font-medium text-foreground">Soft delete — recommended</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Takes the ticket off the board. Notes, tasks, calls and messages stay on
                record and this can be undone later.
              </p>
            </div>
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <p className="font-medium text-destructive">Hard delete — permanent</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Permanently deletes the ticket along with its remarks and follow-up tasks.
                Cannot be undone. Calls, messages and documents stay on the guest&apos;s
                record — just no longer linked to this lead.
              </p>
            </div>
          </div>
          {deleteError && (
            <div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {deleteError}
            </div>
          )}
          {/* Three buttons need ~310px; a 320px phone can't fit them in a row,
              so stack (reversed, keeping Cancel last/bottom) until sm+. */}
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              onClick={() => setConfirmingDelete(false)}
              disabled={Boolean(deleting)}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => deleteLead("soft")}
              disabled={Boolean(deleting)}
              className="w-full sm:w-auto"
            >
              {deleting === "soft" && <Loader2 className="h-4 w-4 animate-spin" />}
              Soft delete
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteLead("hard")}
              disabled={Boolean(deleting)}
              className="w-full sm:w-auto"
            >
              {deleting === "hard" && <Loader2 className="h-4 w-4 animate-spin" />}
              Hard delete
            </Button>
          </div>
        </div>
    </Dialog>
  </>
  );
}

function errorMessage(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message.trim() : "";
  return msg || fallback;
}

/** A remark's voice note or file — same inline-audio/download-chip
 *  treatment as the WhatsApp panel's attachment bubble. */
function NoteAttachment({
  attachment,
}: {
  attachment: { id: string; filename: string; mimeType: string; sizeBytes: number };
}) {
  if (attachment.mimeType.startsWith("audio/")) {
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <audio controls src={`/api/files/${attachment.id}?inline=1`} className="mt-1.5 h-9 w-full max-w-xs" />;
  }
  return (
    <a
      href={`/api/files/${attachment.id}`}
      className="mt-1.5 flex max-w-xs items-center gap-2 rounded-md border border-border bg-secondary/40 px-2.5 py-1.5 text-xs hover:bg-secondary/70"
    >
      <FileText className="h-4 w-4 shrink-0 text-brand-600" />
      <span className="min-w-0 truncate">{attachment.filename}</span>
      <Download className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </a>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium capitalize text-foreground">{value}</div>
    </div>
  );
}
