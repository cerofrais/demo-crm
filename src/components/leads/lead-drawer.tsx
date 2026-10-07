"use client";

import { useEffect, useRef, useState } from "react";
import { X, Clock, Calendar, MessageSquare, FileText, FolderOpen, GitMerge, Mail, MessageCircle, Loader2, Plus, Phone, Play, Sparkles, Trash2, Ban, Paperclip, Download, CheckCircle2, XCircle, ClipboardList, Mic } from "lucide-react";
import { Button, Input, Select, Textarea, Badge, Sheet, Dialog, ScrollableTabs, type TabItem } from "@/components/ui";
import { AudioRecordButton } from "@/components/ui/audio-record-button";
import { STAGES, STAGE_MAP } from "@/lib/kanban";
import { api } from "@/lib/client";
import { MediaOverlay } from "@/components/media/media-overlay";
import { MergeLeadDialog } from "@/components/leads/merge-lead-dialog";
import { cn, formatINR, formatIST } from "@/lib/utils";
import { formatTag, sortTags, isSystemTag } from "@/lib/lead-tags";
import { validateIndianPhone } from "@/lib/validation";
import { bookingTotalINR } from "@/lib/booking-details";
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

type OpenTaskItem = EnquiryDTO["openTasks"]["items"][number];

/** Names for the system-generated task kinds; an ordinary follow-up needs none. */
const TASK_KIND_LABEL: Record<string, string> = {
  doctor_review: "Doctor review",
  payment_pending: "Payment chase",
  deletion_approval: "Lost/Dead approval",
};

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
    gender: "",
    quotedPriceINR: "",
    stage: "new_lead" as EnquiryStage,
    intakeNotes: "",
    preferredCheckIn: "",
    occupancy: "",
    companionName: "",
    stayDays: "",
    roomCount: "",
    pricePerDayINR: "",
    roomCategory: "",
  });
  const [vocab, setVocab] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  // Mutation errors are surfaced inline — without these a 403/409/network
  // failure just stopped the spinner and looked exactly like a success.
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [remarkError, setRemarkError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDate, setTaskDate] = useState(() => defaultTaskDateTime().date);
  const [taskTime, setTaskTime] = useState(() => defaultTaskDateTime().time);
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  // Set when the lead already has open tasks: the rep confirms before adding
  // another, so the same follow-up doesn't get scheduled twice.
  const [taskConfirm, setTaskConfirm] = useState<OpenTaskItem[] | null>(null);
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
      gender: enquiry.guest.gender ?? "",
      quotedPriceINR: enquiry.quotedPriceINR?.toString() ?? "",
      stage: enquiry.stage,
      intakeNotes: enquiry.intakeNotes ?? "",
      // Stored at UTC midnight for the guest's calendar date, so slicing the
      // ISO string gives the <input type="date"> value back unchanged. Going
      // via local time here would shift it a day for anyone west of UTC.
      preferredCheckIn: enquiry.preferredCheckIn?.slice(0, 10) ?? "",
      occupancy: enquiry.occupancy ?? "",
      companionName: enquiry.companionName ?? "",
      stayDays: enquiry.stayDays?.toString() ?? "",
      roomCount: enquiry.roomCount?.toString() ?? "",
      pricePerDayINR: enquiry.pricePerDayINR?.toString() ?? "",
      roomCategory: enquiry.roomCategory ?? "",
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
        // "" clears it; the schema maps that to null.
        gender: form.gender,
        quotedPriceINR: form.quotedPriceINR ? Number(form.quotedPriceINR) : null,
        stage: form.stage,
        intakeNotes: form.intakeNotes,
        // "" clears the date; the schema maps it to null.
        preferredCheckIn: form.preferredCheckIn,
        occupancy: form.occupancy,
        // Sent as cleared whenever occupancy isn't double, so what is stored
        // always matches what the rep could actually see and edit — the field
        // is hidden in that case, and a name left behind from an earlier
        // double booking would otherwise silently persist.
        companionName: form.occupancy === "double" ? form.companionName : "",
        stayDays: form.stayDays ? Number(form.stayDays) : null,
        roomCount: form.roomCount ? Number(form.roomCount) : null,
        pricePerDayINR: form.pricePerDayINR ? Number(form.pricePerDayINR) : null,
        roomCategory: form.roomCategory,
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

  /**
   * Hand what the rep captured to the model and put the draft back in the box.
   *
   * It never posts: the text lands in the same textarea the rep was typing in,
   * so it is read and corrected before it becomes part of the lead's history.
   * The attachment stays attached — the photo is evidence of what was read.
   */
  async function draftRemarkWithAi() {
    if (!enquiry || (!remark.trim() && !remarkAttachment)) return;
    setRemarkError(null);
    setDraftNote(null);
    setDrafting(true);
    try {
      const form = new FormData();
      form.append("text", remark);
      if (remarkAttachment) form.append("file", remarkAttachment);
      const draft = await api.upload<{ remark: string; transcript: string | null; usedImages: number }>(
        `/api/enquiries/${enquiry.id}/remark-draft`,
        form,
      );
      setRemark(draft.remark);
      const read = [
        draft.usedImages ? `${draft.usedImages} image${draft.usedImages > 1 ? "s" : ""}` : null,
        draft.transcript ? "a voice note" : null,
      ].filter(Boolean);
      setDraftNote(
        `Drafted${read.length ? ` from ${read.join(" and ")}` : ""} — check it before posting.${
          draft.transcript ? ` Heard: "${draft.transcript.slice(0, 200)}"` : ""
        }`,
      );
    } catch (e) {
      setRemarkError(errorMessage(e, "Couldn't draft that. Try again, or write it yourself."));
    } finally {
      setDrafting(false);
    }
  }

  async function addRemark(kind: "remark" | "comment" = "remark") {
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
      await api.post(`/api/enquiries/${enquiry.id}/notes`, { body: remark, attachmentDocumentId, kind });
      setRemark("");
      setRemarkAttachment(null);
      if (remarkFileRef.current) remarkFileRef.current.value = "";
      if (tab === "activity") {
        const tl = await api.get<TimelineItemDTO[]>(`/api/enquiries/${enquiry.id}/timeline`);
        setTimeline(tl);
      }
    } catch (e) {
      setRemarkError(errorMessage(e, `Couldn't add the ${kind}. Please try again.`));
    } finally {
      setSaving(false);
    }
  }

  /** The picked date/time as the API's "N hours/days from now", or null
   *  (with an error shown) when it isn't in the future. */
  function taskDue(): { amount: number; unit: "hours" | "days" } | null {
    // The API still speaks "amount N hours/days from now" — this only
    // changes how staff pick the due time, not the task-creation contract.
    const dueAt = new Date(`${taskDate}T${taskTime}`);
    const diffMs = dueAt.getTime() - Date.now();
    if (!Number.isFinite(dueAt.getTime()) || diffMs <= 0) {
      setTaskError("Pick a date and time in the future.");
      return null;
    }
    const diffHours = Math.round(diffMs / (60 * 60 * 1000));
    const amount = diffHours <= 365 ? Math.max(1, diffHours) : Math.min(365, Math.round(diffMs / (24 * 60 * 60 * 1000)));
    const unit: "hours" | "days" = diffHours <= 365 ? "hours" : "days";
    return { amount, unit };
  }

  /**
   * Add-task button. Checks the lead's open tasks first and asks for
   * confirmation when there are any, so a rep sees what is already scheduled
   * before piling another reminder on top.
   *
   * Read fresh from the server rather than from the card, which can be stale
   * if another rep added a task since the board loaded. If the check itself
   * fails, the task is added anyway — a failed lookup is no reason to stop
   * someone doing their job.
   */
  async function requestAddTask() {
    if (!enquiry || !taskTitle.trim() || !taskDate || !taskTime) return;
    setTaskError(null);
    if (!taskDue()) return;

    setTaskSaving(true);
    let existing: OpenTaskItem[] = [];
    try {
      const res = await api.get<{ items: OpenTaskItem[] }>(`/api/enquiries/${enquiry.id}/tasks`);
      existing = res.items;
    } catch {
      existing = [];
    }
    if (existing.length > 0) {
      setTaskSaving(false);
      setTaskConfirm(existing);
      return;
    }
    await createTask();
  }

  async function createTask() {
    if (!enquiry || !taskTitle.trim() || !taskDate || !taskTime) return;
    setTaskError(null);
    const due = taskDue();
    if (!due) {
      setTaskConfirm(null);
      return;
    }

    setTaskSaving(true);
    try {
      await api.post(`/api/enquiries/${enquiry.id}/tasks`, {
        title: taskTitle,
        amount: due.amount,
        unit: due.unit,
      });
      setTaskConfirm(null);
      setTaskTitle("");
      const next = defaultTaskDateTime();
      setTaskDate(next.date);
      setTaskTime(next.time);
      if (tab === "activity") {
        const tl = await api.get<TimelineItemDTO[]>(`/api/enquiries/${enquiry.id}/timeline`);
        setTimeline(tl);
      }
      // Refresh the lead so its card's task count updates without a reload.
      api.get<EnquiryDTO>(`/api/enquiries/${enquiry.id}`).then(onUpdated).catch(() => {});
    } catch (e) {
      setTaskConfirm(null);
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
  // Derived, never stored: a total that disagreed with days x rate would be
  // worse than no total at all. Blank while either half is empty.
  const bookingTotal = bookingTotalINR(
    form.stayDays ? Number(form.stayDays) : null,
    form.pricePerDayINR ? Number(form.pricePerDayINR) : null,
  );
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
            {enquiry.isReturningFlag && (
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
          {canWorkLeads && (
            <button
              onClick={() => setMerging(true)}
              aria-label="Merge a duplicate into this lead"
              title="Merge a duplicate into this lead"
              className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground lg:h-9 lg:w-9"
            >
              <GitMerge className="h-4 w-4" />
            </button>
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

      {/* Returning banner — only for a guest who had stayed before this lead
          (see lib/guest-visits.ts), and only claims a health record when one
          exists. */}
      {enquiry.isReturningFlag && (
        <div className="shrink-0 border-b border-brand-200 bg-brand-50 px-4 py-2 text-sm text-brand-800 md:px-6">
          {g.hasHealthRecord
            ? "Previously visited — health & preference history is on file. Confirm contact details only."
            : g.hasHealthRecord === false
              ? "Previously visited — no health record on file yet."
              : "Previously visited."}
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
              {/* Set by hand: none of the intake forms asks for it. */}
              <Field label="Gender">
                <Select
                  value={form.gender}
                  disabled={!canWorkLeads}
                  onChange={(e) => setForm((f) => ({ ...f, gender: e.target.value }))}
                >
                  <option value="">—</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                  <option value="other">Other</option>
                </Select>
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
              {/* Booking detail — every field optional, and independent of the
                  others. Grouped in its own box because these only become
                  relevant once a stay is being firmed up, and reps scanning
                  the form for a phone number shouldn't have to read past
                  them. Companion name is the one field gated on occupancy:
                  it means nothing for a single room. */}
              <div className="space-y-3 rounded-lg border border-border/60 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Booking details{" "}
                  <span className="font-normal normal-case tracking-normal">— all optional</span>
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Occupancy">
                    <Select
                      value={form.occupancy}
                      disabled={!canWorkLeads}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          occupancy: e.target.value,
                          // Switching off double drops the companion in the
                          // same update, so the hidden field can never keep a
                          // name that contradicts the occupancy on screen.
                          companionName: e.target.value === "double" ? f.companionName : "",
                        }))
                      }
                    >
                      <option value="">—</option>
                      <option value="single">Single</option>
                      <option value="double">Double</option>
                    </Select>
                  </Field>
                  <Field label="Room category">
                    <Select
                      value={form.roomCategory}
                      disabled={!canWorkLeads}
                      onChange={(e) => setForm((f) => ({ ...f, roomCategory: e.target.value }))}
                    >
                      <option value="">—</option>
                      <option value="premium">Premium</option>
                      <option value="executive">Executive</option>
                    </Select>
                  </Field>
                </div>
                {form.occupancy === "double" && (
                  <Field label="Staying with">
                    <Input
                      value={form.companionName}
                      placeholder="Other guest's name"
                      maxLength={120}
                      disabled={!canWorkLeads}
                      onChange={(e) => setForm((f) => ({ ...f, companionName: e.target.value }))}
                    />
                  </Field>
                )}
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Days">
                    <Input
                      type="number"
                      min={1}
                      max={365}
                      value={form.stayDays}
                      placeholder="e.g. 7"
                      disabled={!canWorkLeads}
                      onChange={(e) => setForm((f) => ({ ...f, stayDays: e.target.value }))}
                    />
                  </Field>
                  <Field label="Rooms">
                    <Input
                      type="number"
                      min={1}
                      max={50}
                      value={form.roomCount}
                      placeholder="e.g. 2"
                      disabled={!canWorkLeads}
                      onChange={(e) => setForm((f) => ({ ...f, roomCount: e.target.value }))}
                    />
                  </Field>
                  <Field label="Price/day (INR)">
                    <Input
                      type="number"
                      min={0}
                      value={form.pricePerDayINR}
                      placeholder="e.g. 12000"
                      disabled={!canWorkLeads}
                      onChange={(e) => setForm((f) => ({ ...f, pricePerDayINR: e.target.value }))}
                    />
                  </Field>
                </div>
                {bookingTotal != null && (
                  <p className="text-xs text-muted-foreground">
                    Total for the stay:{" "}
                    <span className="font-medium text-foreground">{formatINR(bookingTotal)}</span>
                  </p>
                )}
              </div>
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
                <Meta label="City" value={g.city ?? "—"} />
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
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={draftRemarkWithAi}
                      disabled={saving || drafting || (!remark.trim() && !remarkAttachment)}
                      title="Write this up with AI — reads an attached photo or voice note"
                    >
                      {drafting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => addRemark("comment")}
                      disabled={saving || (!remark.trim() && !remarkAttachment)}
                      className="ml-auto border-amber-300 bg-amber-100 text-amber-900 hover:bg-amber-200"
                      title="Internal — left out of the Cresent report"
                    >
                      Add comment
                    </Button>
                    <Button onClick={() => addRemark("remark")} disabled={saving || (!remark.trim() && !remarkAttachment)}>
                      {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                      Add remark
                    </Button>
                  </div>
                  {draftNote && <p className="text-xs text-muted-foreground">{draftNote}</p>}
                  <p className="text-xs text-muted-foreground">
                    Both go on the activity timeline. A <strong>remark</strong> is the lead&rsquo;s working record and
                    appears in the Cresent report; a <strong>comment</strong> is internal and is left out of it. Attach a
                    voice note or file with the mic/paperclip buttons, and use the ✨ button to have the model write it
                    up from a photo, a voice note or your shorthand.
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
                      onClick={requestAddTask}
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

              {taskConfirm && (
                <Dialog
                  open
                  onClose={() => !taskSaving && setTaskConfirm(null)}
                  title="This lead already has tasks"
                  className="md:max-w-md"
                >
                  <div className="space-y-4 px-4 py-5 md:px-6">
                    <p className="text-sm text-foreground">
                      {taskConfirm.length === 1 ? "There is 1 open task" : `There are ${taskConfirm.length} open tasks`} on
                      this lead. Add &ldquo;<span className="font-medium">{taskTitle.trim()}</span>&rdquo; as well?
                    </p>
                    <ul className="max-h-60 space-y-1.5 overflow-y-auto">
                      {taskConfirm.map((t) => {
                        const overdue = Boolean(t.dueAt && new Date(t.dueAt) < new Date());
                        return (
                          <li key={t.id} className="flex items-start gap-2 rounded-md border border-border px-2.5 py-2 text-sm">
                            <ClipboardList className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0">
                              <div className="text-foreground">{t.title}</div>
                              <div className={cn("text-xs", overdue ? "text-destructive" : "text-muted-foreground")}>
                                {TASK_KIND_LABEL[t.kind] ? `${TASK_KIND_LABEL[t.kind]} · ` : ""}
                                {t.dueAt
                                  ? `${overdue ? "Overdue — was due" : "Due"} ${formatIST(t.dueAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
                                  : "No due date"}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" onClick={() => setTaskConfirm(null)} disabled={taskSaving}>
                        Cancel
                      </Button>
                      <Button onClick={createTask} disabled={taskSaving}>
                        {taskSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                        Add anyway
                      </Button>
                    </div>
                  </div>
                </Dialog>
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
                // An internal comment: same timeline, visibly not a remark,
                // because it is the one kind of note the Cresent report
                // leaves out and nobody should have to remember which is which.
                const isComment = item.kind === "note" && item.noteKind === "comment";
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
                // A WhatsApp voice note: the mic marks it at a glance, and the
                // transcript (or why there isn't one yet) comes from the
                // timeline API — see lib/ai/voice-note-transcribe.ts.
                const isVoiceNote = item.meta?.voiceNote === true;
                const transcript =
                  typeof item.meta?.transcript === "string" ? item.meta.transcript : null;
                const transcriptStatus =
                  typeof item.meta?.transcriptStatus === "string" ? item.meta.transcriptStatus : null;
                return (
                  <div
                    key={item.id}
                    onClick={taskId ? () => router.push(`/tasks?task=${taskId}`) : undefined}
                    title={taskId ? "Open this task in Tasks & Reminders" : undefined}
                    className={cn(
                      "rounded-lg border p-3",
                      isComment
                        ? "border-amber-200 bg-amber-50/70"
                        : isAdminNote
                          ? "border-indigo-200 bg-indigo-50/70"
                          : item.kind === "note"
                            ? "border-border bg-brand-50/60"
                            : "border-border",
                      taskId && "cursor-pointer transition-colors hover:border-brand-300 hover:bg-brand-50/40",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                        {isVoiceNote && (
                          <Mic className="h-3.5 w-3.5 shrink-0 text-brand-600" aria-label="Voice note" />
                        )}
                        {item.actorName}
                        {isAdminNote && (
                          <Badge className="bg-indigo-100 text-indigo-700">Admin</Badge>
                        )}
                        {isComment && (
                          <Badge
                            className="bg-amber-100 text-amber-800"
                            title="Internal comment — left out of the Cresent report"
                          >
                            Comment
                          </Badge>
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
                    {isVoiceNote && (transcript || transcriptStatus) && (
                      <p
                        className={cn(
                          "mt-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-sm",
                          transcript ? "text-foreground" : "italic text-muted-foreground",
                        )}
                      >
                        {transcript ? `“${transcript}”` : transcriptStatus}
                      </p>
                    )}
                    {item.attachment && <TimelineAttachment attachment={item.attachment} />}
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
        {/* Time as well as date: "which of this morning's leads came in first"
            is a question reps actually ask, and the date alone can't answer
            it. formatIST pins this to Asia/Kolkata regardless of the viewer's
            own clock — see lib/utils. */}
        {formatIST(enquiry.createdAt, { dateStyle: "medium", timeStyle: "short" })}
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

    {merging && enquiry && (
      <MergeLeadDialog
        target={enquiry}
        onClose={() => setMerging(false)}
        onMerged={async () => {
          setMerging(false);
          // The lead now holds the other card's history, and the board has one
          // card fewer — re-read the lead and hand it up rather than patching
          // pieces of a drawer that is showing half the story.
          const fresh = await api.get<EnquiryDTO>(`/api/enquiries/${enquiry.id}`).catch(() => null);
          if (fresh) onUpdated(fresh);
          router.refresh();
        }}
      />
    )}
  </>
  );
}

function errorMessage(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message.trim() : "";
  return msg || fallback;
}

/** A remark's voice note or file — same inline-audio/download-chip
 *  treatment as the WhatsApp panel's attachment bubble. */
/**
 * A file on a timeline entry — a remark's attachment, or the photo or voice
 * note a WhatsApp message carried.
 *
 * An image is shown, not linked: the activity log is where someone goes to
 * find out what happened, and "IMG-20260930.jpg" tells them nothing. Audio
 * plays in place for the same reason — a voice note that has to be downloaded
 * to be heard is a voice note nobody listens to. Anything else stays a
 * download, since the browser cannot be trusted to render it safely.
 *
 * `?inline=1` is honoured only for types the storage layer marks inline-safe
 * (see lib/storage.ts), so an SVG or an HTML file still downloads.
 */
function TimelineAttachment({
  attachment,
}: {
  attachment: { id: string; filename: string; mimeType: string; sizeBytes: number };
}) {
  const [overlay, setOverlay] = useState(false);
  const inline = `/api/files/${attachment.id}?inline=1`;

  if (attachment.mimeType.startsWith("image/")) {
    return (
      <>
        <button type="button" onClick={() => setOverlay(true)} className="mt-1.5 block w-fit" title={attachment.filename}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={inline}
            alt={attachment.filename}
            loading="lazy"
            className="max-h-56 max-w-full rounded-md border border-border object-contain transition-opacity hover:opacity-90"
          />
        </button>
        {overlay && <MediaOverlay media={attachment} onClose={() => setOverlay(false)} />}
      </>
    );
  }

  if (attachment.mimeType.startsWith("audio/")) {
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <audio controls preload="none" src={inline} className="mt-1.5 h-9 w-full max-w-xs" />;
  }

  if (attachment.mimeType.startsWith("video/")) {
    return (
      <>
        <Button type="button" variant="outline" size="sm" className="mt-1.5" onClick={() => setOverlay(true)}>
          <Play className="h-3.5 w-3.5" /> Play video
        </Button>
        {overlay && <MediaOverlay media={attachment} onClose={() => setOverlay(false)} />}
      </>
    );
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
