"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, ChevronUp, MessageCircle, AlertTriangle, Paperclip, X, FileText, Download, Pencil, Trash2, Check, CheckCheck, Mic } from "lucide-react";
import { Button, Textarea, Select, Badge, Dialog } from "@/components/ui";
import { AudioRecordButton } from "@/components/ui/audio-record-button";
import { api } from "@/lib/client";
import { MediaOverlay } from "@/components/media/media-overlay";
import { LayoutTemplate } from "lucide-react";
import { MessageBody } from "@/components/messaging/message-body";
import { cn, formatIST } from "@/lib/utils";
import { isStatusStale, STATUS_STALE_MINUTES } from "@/lib/message-display";

/** How often an open thread re-checks for new messages and delivery status.
 *  Meta usually confirms within seconds, so this is the difference between a
 *  rep seeing "failed" while they still remember sending it, and finding out
 *  tomorrow. */
const THREAD_POLL_MS = 8000;
import type { MessageDTO } from "@/lib/types";
import { isVoiceNoteMime, transcriptText } from "@/lib/voice-note";
import { TemplatePicker } from "@/components/messaging/template-picker";
import { MetaTemplatePicker, type MetaTemplateSend } from "@/components/whatsapp/meta-template-picker";
import { PackagePicker } from "@/components/messaging/package-picker";
import { AttachmentPicker, type AttachmentSelection } from "@/components/messaging/attachment-picker";
import { personalizeTemplate } from "@/lib/message-templates";

interface NumberOption {
  id: string;
  label: string;
  phoneNumber: string | null;
  isDefault: boolean;
  instanceName: string;
  /** "cloud_api" for the official Meta line, "baileys" for a QR-paired one. */
  integration: string;
}

// Deterministic color per WhatsApp number, keyed off the PHONE NUMBER, so a
// number's dropdown color and its incoming messages' bubble color match.
//
// Not the Evolution instance name (Message.mailboxId): a line gets a new
// instance every time it is re-paired, so keying on it gave one number a
// different color for each pairing — the 60 line showed green, cyan and pink
// in a single thread. The number is what staff think of as "the line".
// Ordered for contrast between NEIGHBOURS, since lines take slots in order:
// the first few lines — which is all this deployment has — get colors that
// can't be mistaken for each other (pink and rose, say, never sit adjacent).
const NUMBER_COLOR_PALETTE = [
  { bg: "bg-sky-50", border: "border-sky-200", text: "text-sky-700", dot: "bg-sky-500", hex: "#0369a1" },
  { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-700", dot: "bg-amber-500", hex: "#b45309" },
  { bg: "bg-violet-50", border: "border-violet-200", text: "text-violet-700", dot: "bg-violet-500", hex: "#6d28d9" },
  { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-700", dot: "bg-emerald-500", hex: "#047857" },
  { bg: "bg-rose-50", border: "border-rose-200", text: "text-rose-700", dot: "bg-rose-500", hex: "#be123c" },
  { bg: "bg-cyan-50", border: "border-cyan-200", text: "text-cyan-700", dot: "bg-cyan-500", hex: "#0e7490" },
  { bg: "bg-orange-50", border: "border-orange-200", text: "text-orange-700", dot: "bg-orange-500", hex: "#c2410c" },
  { bg: "bg-indigo-50", border: "border-indigo-200", text: "text-indigo-700", dot: "bg-indigo-500", hex: "#4338ca" },
  { bg: "bg-lime-50", border: "border-lime-200", text: "text-lime-700", dot: "bg-lime-500", hex: "#4d7c0f" },
  { bg: "bg-pink-50", border: "border-pink-200", text: "text-pink-700", dot: "bg-pink-500", hex: "#be185d" },
];

function hashKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The color key for a number option: its phone number, or its instance for
 *  a line that hasn't reported one yet. */
function lineKey(n: NumberOption | undefined): string | undefined {
  return n ? n.phoneNumber ?? n.instanceName : undefined;
}

/**
 * A line's color. `slots` is the server's org-wide assignment (one slot per
 * number, in a fixed order), which guarantees distinct colors; hashing is
 * only the fallback for a key the server didn't list — hashing alone put the
 * 60 and 52 lines on pink and rose, which read as the same color.
 */
function numberColor(key: string | null | undefined, slots?: Record<string, number>) {
  if (!key) return null;
  const slot = slots?.[key];
  const i = slot ?? hashKey(key);
  return NUMBER_COLOR_PALETTE[i % NUMBER_COLOR_PALETTE.length];
}

interface ThreadResponse {
  items: MessageDTO[]; // newest-first
  nextCursor: string | null;
  guestPhone: string | null;
  canSend: boolean;
  numberOptions: NumberOption[];
  /** Org-wide color slot per line (E.164 → index). */
  lineColorSlots?: Record<string, number>;
  /** An admin has pinned this person to specific lines (Users page). */
  restrictedToNumbers?: boolean;
  /** The number this conversation was last on, if any — the reply picker
   * should default to it instead of the org-wide default number. */
  suggestedNumberId: string | null;
  /** The number this conversation actually lives on, reported even when it is
   *  no longer connected — which is when the guest is most at risk of getting
   *  a reply from a line they don't recognise. */
  establishedNumber: {
    id: string;
    label: string;
    phoneNumber: string | null;
    selectable: boolean;
    integration?: string;
  } | null;
  /** The current staff member's own connected number, if their phone is
   * also a WhatsApp number — outranks the org default so they don't send
   * from a line that isn't theirs without noticing. */
  myNumberId: string | null;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** WhatsApp's own single/double/blue-double-check convention, for an
 *  outbound message's status — sent (single, requested but not yet
 *  confirmed further) / delivered (double, grey) / read (double, brand
 *  color). Nothing rendered for "failed" (the destructive Badge already
 *  covers that) or an unrecognized status.
 *
 *  A message stuck at "sent" long past that gets an amber dot instead. The
 *  single tick means "on its way", and that becomes a lie when the status
 *  webhook is down: ~200 messages sat on a tick for a day while their real
 *  outcome — much of it failure — never arrived. Meta only PUSHES delivery
 *  status and offers no way to read it back afterwards, so those messages
 *  can never be resolved; the honest thing is to show the outcome is
 *  unknown rather than quietly imply progress. */
function DeliveryTicks({ status, sentAt }: { status: string; sentAt: string }) {
  if (status === "read") return <CheckCheck className="h-3.5 w-3.5 shrink-0 text-brand-600" />;
  if (status === "delivered") return <CheckCheck className="h-3.5 w-3.5 shrink-0" />;
  if (status === "sent") return <Check className="h-3.5 w-3.5 shrink-0" />;
  return null;
}

/**
 * A message WhatsApp never reported back on. Carries the same red weight as
 * "Failed" because it needs the same attention — most of these did fail — but
 * says "Not confirmed" rather than claiming an outcome we were never told.
 * The two must stay distinguishable: a Failed badge is backed by an error
 * Meta actually returned and shows its reason, this one is backed by silence.
 * Meta only pushes delivery status and offers no way to query it afterwards,
 * so a message that ages out here can never be resolved.
 */
function UnconfirmedBadge() {
  return (
    <Badge
      className="bg-destructive/10 text-destructive"
      title={`No delivery confirmation after ${STATUS_STALE_MINUTES} minutes — WhatsApp never reported back, so this may not have arrived. It cannot be checked after the fact.`}
    >
      Not confirmed
    </Badge>
  );
}

/**
 * The quoted message shown above a reply, mirroring WhatsApp's own layout: a
 * left accent bar, who was being quoted, and a one-line excerpt. Rendered
 * inside the bubble so it stays visually attached to the reply itself.
 */
function QuotedReply({ replyTo }: { replyTo: NonNullable<MessageDTO["replyTo"]> }) {
  return (
    <div className="mb-1 rounded-md border-l-[3px] border-primary/60 bg-foreground/[0.06] px-2 py-1">
      <div className="text-[11px] font-medium text-primary/90">
        {replyTo.direction === "outbound" ? "You" : "Them"}
      </div>
      <div className="line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
        {replyTo.body}
      </div>
    </div>
  );
}

function Attachment({ attachment }: { attachment: NonNullable<MessageDTO["attachment"]> }) {
  const [overlay, setOverlay] = useState(false);

  if (attachment.mimeType.startsWith("image/")) {
    return (
      <>
      {/* Opens over the thread rather than in a new tab: a photo is a glance,
          and a new tab loses the conversation you were reading. */}
      <button type="button" onClick={() => setOverlay(true)} className="block min-w-0">
        {/* w-auto max-w-full keeps a wide photo inside the 85% bubble instead of
            forcing the whole tab to scroll sideways; object-contain because
            object-cover is a no-op without a fixed width/height pair. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/files/${attachment.id}?inline=1`}
          alt={attachment.filename}
          className="mb-1 h-auto max-h-56 w-auto max-w-full rounded-md border border-border object-contain transition-opacity hover:opacity-90"
        />
      </button>
      {overlay && <MediaOverlay media={attachment} onClose={() => setOverlay(false)} />}
      </>
    );
  }
  if (attachment.mimeType.startsWith("audio/")) {
    // min-w-0: the native player has a wide intrinsic width and would otherwise
    // refuse to shrink inside the flex bubble.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <audio controls src={`/api/files/${attachment.id}?inline=1`} className="mb-1 h-9 w-full min-w-0 max-w-full" />;
  }
  // Everything else (documents, and video which has no dedicated player here)
  // renders as a download chip.
  return (
    <a
      href={`/api/files/${attachment.id}`}
      className="mb-1 flex min-w-0 items-center gap-2 rounded-md border border-border bg-secondary/40 px-2.5 py-1.5 text-xs hover:bg-secondary/70"
    >
      <FileText className="h-4 w-4 shrink-0 text-brand-600" />
      {/* min-w-0 so a long filename actually truncates rather than stretching the chip. */}
      <span className="min-w-0 truncate">{attachment.filename}</span>
      <Download className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </a>
  );
}

/**
 * What a voice note says, under its player — the same transcript the activity
 * log shows, so a rep can read a note they can't play out loud. Renders
 * nothing for anything that isn't a voice note.
 */
function VoiceNoteTranscript({ m }: { m: MessageDTO }) {
  if (!isVoiceNoteMime(m.attachment?.mimeType)) return null;
  const text = transcriptText(m);
  const status = m.transcriptStatus ?? null;
  if (!text && !status) return null;
  return (
    <p
      className={cn(
        "mb-1 flex items-start gap-1.5 rounded-md bg-black/5 px-2 py-1.5 text-xs",
        text ? "" : "italic opacity-70",
      )}
    >
      <Mic className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      <span className="min-w-0 whitespace-pre-wrap break-words">{text ?? status}</span>
    </p>
  );
}

export function WhatsAppPanel({
  guestId,
  guestName,
  guestGender,
  enquiryId,
}: {
  guestId: string;
  guestName: string;
  guestGender?: string | null;
  enquiryId?: string;
}) {
  const [items, setItems] = useState<MessageDTO[]>([]); // chronological
  const [meta, setMeta] = useState<Omit<ThreadResponse, "items" | "nextCursor">>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [numberId, setNumberId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [attachment, setAttachment] = useState<AttachmentSelection | null>(null);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [uploadCategory, setUploadCategory] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** Which guest the current `numberId` was resolved for — see load(). */
  const numberChosenForGuest = useRef<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [messageBusy, setMessageBusy] = useState<string | null>(null);
  // Set when the rep is about to reply from a number this guest has never
  // seen — cleared by picking one of the options in the dialog.
  const [numberWarning, setNumberWarning] = useState<{ from: string; to: string } | null>(null);

  useEffect(() => {
    api
      .get<{ uploadable: string[] }>("/api/files/meta")
      .then((m) => setUploadCategory(m.uploadable.includes("operational") ? "operational" : (m.uploadable[0] ?? null)))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<ThreadResponse>(`/api/guests/${guestId}/whatsapp`);
      setItems([...res.items].reverse()); // oldest→newest
      setNextCursor(res.nextCursor);
      setMeta(res);
      // `prev ||` keeps a rep's deliberate mid-conversation switch across a
      // refresh — but ONLY for the guest they made it on. Without the guard
      // the selection followed them into the next lead they opened, so the
      // composer sat on a number that conversation had never used, and the
      // warning fired on a thread the rep had not actually touched.
      // A conversation already on the official Cloud API line stays there,
      // ahead of every other preference including a rep's own earlier switch:
      // the picker is hidden for it, so a stale selection would otherwise send
      // from a line the page is no longer offering.
      const cloudApiLock =
        res.establishedNumber?.integration === "cloud_api" && res.establishedNumber.selectable
          ? res.establishedNumber.id
          : null;
      setNumberId((prev) =>
        cloudApiLock ||
        (numberChosenForGuest.current === guestId ? prev : "") ||
        res.suggestedNumberId ||
        res.myNumberId ||
        res.numberOptions.find((n) => n.isDefault)?.id ||
        res.numberOptions[0]?.id ||
        "",
      );
      numberChosenForGuest.current = guestId;
      setTimeout(() => bottomRef.current?.scrollIntoView({ block: "end" }), 50);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load WhatsApp thread");
    } finally {
      setLoading(false);
    }
  }, [guestId]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Keep an open thread current without a reload.
   *
   * Delivery status arrives on Meta's webhook seconds AFTER the send, and a
   * reply can land at any moment — but the panel only ever fetched on mount,
   * so a message the API had already marked failed sat on screen as a hopeful
   * single tick until someone reopened the lead. Reps were reading "sent" for
   * messages that had demonstrably failed.
   *
   * Merges rather than replaces: existing bubbles keep their identity and only
   * their status/edits change, so the list doesn't flicker and an in-progress
   * edit isn't clobbered. Scroll is only nudged when the reader is already at
   * the bottom — yanking someone out of the history they are reading to show
   * them a delivery receipt would be worse than the stale tick.
   */
  useEffect(() => {
    if (!guestId) return;
    let cancelled = false;

    async function sync() {
      // Skip while the tab is hidden: a backgrounded lead drawer polling all
      // day is pure cost, and the mount fetch covers coming back to it.
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await api.get<ThreadResponse>(`/api/guests/${guestId}/whatsapp`);
        if (cancelled) return;
        const fresh = [...res.items].reverse();
        const byId = new Map(fresh.map((m) => [m.id, m]));
        setItems((prev) => {
          const merged = prev.map((m) => byId.get(m.id) ?? m);
          const known = new Set(prev.map((m) => m.id));
          const added = fresh.filter((m) => !known.has(m.id));
          return added.length ? [...merged, ...added] : merged;
        });
        // Meta too, so the number picker and the wrong-number warning follow
        // a reply that lands while the panel is open. `items`/`nextCursor`
        // are excluded deliberately — paging is owned by loadOlder().
        const { items: _items, nextCursor: _next, ...threadMeta } = res;
        setMeta(threadMeta);
      } catch {
        // A failed poll is not worth an error banner — the next tick retries.
      }
    }

    const id = setInterval(sync, THREAD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [guestId]);

  async function loadOlder() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await api.get<ThreadResponse>(`/api/guests/${guestId}/whatsapp?cursor=${nextCursor}`);
      setItems((prev) => [...[...res.items].reverse(), ...prev]);
      setNextCursor(res.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  /** The conversation's own number, and the one the composer is set to. */
  const established = meta?.establishedNumber ?? null;
  /**
   * A conversation on the official Cloud API line stays on it.
   *
   * That line is a different relationship from the QR-paired numbers: Meta
   * holds the 24-hour window, the template rules and the quality rating per
   * number, and answering from a second line both restarts that relationship
   * elsewhere and shows the guest a number they have never seen. So once a
   * guest is talking to 61, the picker stops offering the others rather than
   * warning about them.
   */
  const lockedToCloudApi =
    established?.integration === "cloud_api" && established.selectable ? established : null;
  const selected = meta?.numberOptions.find((n) => n.id === numberId) ?? null;
  // Compared on the PHONE, not the row id: this number has been re-paired
  // repeatedly, and each pairing makes a new row for the same phone. To the
  // guest nothing changed, so warning about it would be noise. Falls back to
  // the id when either side has no phone recorded yet (a freshly paired
  // number has none until it connects).
  const switchingNumber = Boolean(
    established &&
      selected &&
      (established.phoneNumber && selected.phoneNumber
        ? established.phoneNumber !== selected.phoneNumber
        : established.id !== numberId),
  );

  /** Ask first when this reply would arrive from a number the guest has never
   *  seen. Guests read an unfamiliar number as a stranger, and it's what got
   *  two of our own lines restricted — worth one click to confirm. */
  function send() {
    if ((!body.trim() && !attachment) || !numberId) return;
    if (switchingNumber && established) {
      const to = meta?.numberOptions.find((n) => n.id === numberId)?.label ?? "another number";
      setNumberWarning({ from: established.label, to });
      return;
    }
    void doSend();
  }

  /**
   * Store a template's header image as a Document on this guest, the same way
   * a composer attachment is stored, and hand back its id for the send. It
   * belongs on the guest either way: it is a picture they were sent.
   */
  async function uploadHeaderImage(file: File): Promise<string> {
    const category = uploadCategory ?? "operational";
    const { url, storageKey } = await api.post<{ url: string; storageKey: string }>("/api/files/upload-url", {
      filename: file.name,
      mimeType: file.type || "image/jpeg",
      category,
      sizeBytes: file.size,
      guestId,
      ...(enquiryId ? { enquiryId } : {}),
    });
    const put = await fetch(url, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type || "image/jpeg" },
    });
    if (!put.ok) throw new Error(`Image upload failed (${put.status})`);
    const confirmed = await api.post<{ id: string }>("/api/files/confirm", {
      storageKey,
      filename: file.name,
      mimeType: file.type || "image/jpeg",
      category,
      sizeBytes: file.size,
      guestId,
      ...(enquiryId ? { enquiryId } : {}),
    });
    return confirmed.id;
  }

  /**
   * Send an approved Meta template to this guest.
   *
   * Posted as a template rather than as text — the server builds the message
   * from Meta's own copy — and appended to the thread like any other outbound
   * message, since that is what the guest will see.
   */
  async function sendTemplate(template: MetaTemplateSend) {
    if (!numberId) return;
    setNumberWarning(null);
    setSending(true);
    setError(null);
    try {
      const msg = await api.post<MessageDTO>("/api/messages/whatsapp", {
        guestId,
        enquiryId,
        numberId,
        template,
      });
      setItems((prev) => [...prev, msg]);
      // The thread now lives on this number, same as any other send — without
      // this the "you are switching lines" warning fires again on the next
      // message, about a switch that already happened.
      setMeta((m) =>
        m
          ? {
              ...m,
              establishedNumber: {
                id: numberId,
                label: m.numberOptions.find((n) => n.id === numberId)?.label ?? "",
                phoneNumber: m.numberOptions.find((n) => n.id === numberId)?.phoneNumber ?? null,
                selectable: true,
              },
            }
          : m,
      );
      if (msg.status === "failed") setError("The template failed to send. Check the number's connection.");
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 50);
    } finally {
      setSending(false);
    }
  }

  async function doSend() {
    if ((!body.trim() && !attachment) || !numberId) return;
    setNumberWarning(null);
    setSending(true);
    setError(null);
    try {
      let attachmentDocumentId: string | undefined;
      // An existing pick (Resources library, or a file already on this
      // guest's thread) is already a Document — nothing to upload.
      if (attachment?.kind === "existing") {
        attachmentDocumentId = attachment.doc.id;
      } else if (attachment?.kind === "new" && uploadCategory) {
        const attachFile = attachment.file;
        const { url, storageKey } = await api.post<{ url: string; storageKey: string }>(
          "/api/files/upload-url",
          {
            filename: attachFile.name,
            mimeType: attachFile.type || "application/octet-stream",
            category: uploadCategory,
            sizeBytes: attachFile.size,
            guestId,
            ...(enquiryId ? { enquiryId } : {}),
          },
        );
        const put = await fetch(url, {
          method: "PUT",
          body: attachFile,
          headers: { "Content-Type": attachFile.type || "application/octet-stream" },
        });
        if (!put.ok) throw new Error(`Attachment upload failed (${put.status})`);
        const confirmed = await api.post<{ id: string }>("/api/files/confirm", {
          storageKey,
          filename: attachFile.name,
          mimeType: attachFile.type || "application/octet-stream",
          category: uploadCategory,
          sizeBytes: attachFile.size,
          guestId,
          ...(enquiryId ? { enquiryId } : {}),
        });
        attachmentDocumentId = confirmed.id;
      }

      const msg = await api.post<MessageDTO>("/api/messages/whatsapp", {
        guestId,
        enquiryId,
        numberId,
        body: body || undefined,
        attachmentDocumentId,
      });
      setItems((prev) => [...prev, msg]);
      // The conversation now lives on whatever number we just sent from, so
      // move `establishedNumber` with it. Without this the warning keeps
      // firing on every subsequent send: `meta` is only refetched on load,
      // so it would still name the number this thread was on when the panel
      // opened — and the rep gets asked to confirm a switch they already
      // made one message ago.
      setMeta((m) =>
        m
          ? {
              ...m,
              establishedNumber: {
                id: numberId,
                label: m.numberOptions.find((n) => n.id === numberId)?.label ?? "",
                phoneNumber: m.numberOptions.find((n) => n.id === numberId)?.phoneNumber ?? null,
                selectable: true,
              },
            }
          : m,
      );
      setBody("");
      setAttachment(null);
      setAttachNote(null);
      if (msg.status === "failed") setError("The message failed to send. Check the number's connection.");
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 50);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  function startEdit(m: MessageDTO) {
    setEditingId(m.id);
    setEditDraft(m.body);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft("");
  }

  async function saveEdit(id: string) {
    if (!editDraft.trim()) return;
    setMessageBusy(id);
    try {
      const updated = await api.patch<{ id: string; body: string; editedAt: string | null }>(
        `/api/messages/${id}`,
        { body: editDraft.trim() },
      );
      setItems((prev) =>
        prev.map((m) => (m.id === id ? { ...m, body: updated.body, editedAt: updated.editedAt } : m)),
      );
      setEditingId(null);
      setEditDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the correction");
    } finally {
      setMessageBusy(null);
    }
  }

  async function deleteMessage(id: string) {
    setMessageBusy(id);
    try {
      const updated = await api.delete<{ id: string; deletedAt: string | null }>(`/api/messages/${id}`);
      setItems((prev) =>
        prev.map((m) => (m.id === id ? { ...m, deletedAt: updated.deletedAt } : m)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete the message");
    } finally {
      setMessageBusy(null);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex items-center justify-between gap-2 pb-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MessageCircle className="h-3.5 w-3.5" />
          {meta?.guestPhone ? (
            <span>WhatsApp with <span className="font-medium text-foreground">{meta.guestPhone}</span></span>
          ) : (
            <span>No phone number on file for this guest</span>
          )}
        </div>
        {meta && lockedToCloudApi && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={cn("h-2.5 w-2.5 shrink-0 rounded-full", numberColor(lineKey(meta.numberOptions.find((n) => n.id === lockedToCloudApi.id)), meta.lineColorSlots)?.dot)}
            />
            <span className="font-medium text-foreground">{lockedToCloudApi.label}</span>
            <span className="hidden sm:inline" title="This guest writes to the official WhatsApp number, so replies go back on it">
              · kept on this line
            </span>
          </div>
        )}
        {meta && !lockedToCloudApi && meta.numberOptions.length > 1 && (
          <div className="flex items-center gap-1.5">
            {/* Flagged the moment the picker moves off the conversation's own
                number, so the rep sees it before writing rather than at send. */}
            {switchingNumber && established && (
              <span
                className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-500"
                title={`This guest has only ever been messaged on ${established.label}`}
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Not their usual number</span>
              </span>
            )}
            <span
              className={cn("h-2.5 w-2.5 shrink-0 rounded-full", numberColor(lineKey(meta.numberOptions.find((n) => n.id === numberId)), meta.lineColorSlots)?.dot)}
              title="This number's color also marks its incoming messages below"
            />
            <Select value={numberId} onChange={(e) => setNumberId(e.target.value)} className="w-36 lg:h-7 lg:text-xs">
              {meta.numberOptions.map((n) => (
                <option key={n.id} value={n.id} style={{ color: numberColor(lineKey(n), meta.lineColorSlots)?.hex }}>
                  {n.label}{n.id === meta.myNumberId ? " (You)" : ""}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {/* thread — min-h-0 (not a fixed min height) so the thread can shrink when
          the drawer body is short (landscape phone / keyboard open). The parent is
          `min-h-0 flex-1 overflow-hidden`, so any floor here clips the composer
          instead of scrolling it into reach. Matches conversation-panel. */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3">
        {loading ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            {nextCursor && (
              <div className="flex justify-center">
                <Button variant="ghost" size="sm" onClick={loadOlder} disabled={loadingMore}>
                  {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronUp className="h-3.5 w-3.5" />}
                  Load older
                </Button>
              </div>
            )}
            {items.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">No WhatsApp messages yet.</p>
            )}
            {items.map((m) => {
              const outbound = m.direction === "outbound";
              const editable = meta?.canSend && !m.deletedAt && editingId !== m.id;
              // Incoming messages are colored per the number that received
              // them, so a multi-number thread makes it obvious at a glance
              // which line each guest reply came in on. Outbound stays the
              // standard "sent" color regardless of number.
              // toEmail on an inbound WhatsApp message is our number — the
              // line it arrived on. Falls back to the instance only for a row
              // stored without one.
              const color = !outbound ? numberColor(m.toEmail ?? m.mailboxId, meta?.lineColorSlots) : null;
              return (
                <div key={m.id} className={cn("group flex", outbound ? "justify-end" : "justify-start")}>
                  <div
                    className={cn(
                      // min-w-0 lets wide children (media, long words) shrink to the bubble.
                      "min-w-0 max-w-[85%] rounded-lg border px-3 py-2 text-sm shadow-sm",
                      outbound
                        ? "border-brand-200 bg-brand-50"
                        : color
                          ? cn(color.border, color.bg)
                          : "border-border bg-card",
                    )}
                  >
                    <div className="mb-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      {color && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", color.dot)} />}
                      <span className="font-medium text-foreground">
                        {outbound ? m.fromLabel ?? m.fromEmail ?? "You" : m.fromEmail ?? "Guest"}
                      </span>
                      <span>
                        {formatIST(m.createdAt, {
                          day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                        })}
                      </span>
                      {m.editedAt && !m.deletedAt && <span className="italic">(edited)</span>}
                      {outbound && <DeliveryTicks status={m.status} sentAt={m.createdAt} />}
                      {m.status === "failed" && (
                        <Badge className="bg-destructive/10 text-destructive">Failed</Badge>
                      )}
                      {outbound && isStatusStale(m.status, m.createdAt, m.integration) && <UnconfirmedBadge />}
                      {editable && (
                        <span className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            onClick={() => startEdit(m)}
                            title="Correct this message"
                            className="rounded p-0.5 hover:bg-secondary hover:text-foreground"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => deleteMessage(m.id)}
                            disabled={messageBusy === m.id}
                            title="Delete this message"
                            className="rounded p-0.5 hover:bg-destructive/10 hover:text-destructive"
                          >
                            {messageBusy === m.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3" />
                            )}
                          </button>
                        </span>
                      )}
                    </div>
                    {(m.fromEmail || m.toEmail) && (
                      <div className="mb-1 flex items-center gap-1 text-[10px] text-muted-foreground/80">
                        <span>{m.fromEmail ?? "—"}</span>
                        <span>→</span>
                        <span>{m.toEmail ?? "—"}</span>
                      </div>
                    )}

                    {m.deletedAt ? (
                      <div className="flex items-center gap-1.5 italic text-muted-foreground">
                        <Trash2 className="h-3.5 w-3.5" /> Message deleted
                      </div>
                    ) : editingId === m.id ? (
                      <div className="space-y-1.5">
                        <Textarea
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          className="min-h-[56px] text-sm"
                        />
                        <div className="flex items-center justify-end gap-1.5">
                          <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={messageBusy === m.id}>
                            <X className="h-3.5 w-3.5" /> Cancel
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => saveEdit(m.id)}
                            disabled={messageBusy === m.id || !editDraft.trim()}
                          >
                            {messageBusy === m.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                            Save
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {m.replyTo && <QuotedReply replyTo={m.replyTo} />}
                        {m.attachment && <Attachment attachment={m.attachment} />}
                        <VoiceNoteTranscript m={m} />
                        {/* Which approved template this was, above what it
                            said. The name is how a campaign is identified in
                            Meta and in our own reports; the words are what the
                            guest read. A rep needs both. */}
                        {m.metaTemplateName && (
                          <span className="mb-1 inline-flex items-center gap-1 rounded bg-black/5 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground dark:bg-white/10">
                            <LayoutTemplate className="h-3 w-3" />
                            {m.metaTemplateName}
                          </span>
                        )}
                        {m.body && <MessageBody body={m.body} />}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {error && (
        <div className="mt-2 rounded-md bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{error}</div>
      )}

      {/* compose */}
      {meta?.canSend ? (
        <div className="mt-2 space-y-2">
          {attachment && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 px-2.5 py-1.5 text-xs">
              <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {attachment.kind === "new" ? attachment.file.name : attachment.doc.filename}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {humanSize(attachment.kind === "new" ? attachment.file.size : attachment.doc.sizeBytes)}
              </span>
              <button
                onClick={() => { setAttachment(null); setAttachNote(null); }}
                className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                title="Remove attachment"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {attachNote && (
            <p className="px-0.5 text-[11px] text-muted-foreground">{attachNote}</p>
          )}
          <div className="flex items-end gap-2">
            {uploadCategory && (
              <AttachmentPicker
                guestId={guestId}
                openUpward
                disabled={sending || Boolean(attachment)}
                title="Attach from Resources, or upload a new file"
                onSelect={(sel, note) => {
                  setAttachment(sel);
                  setAttachNote(note ?? null);
                }}
              />
            )}
            {uploadCategory && !attachment && (
              <AudioRecordButton
                disabled={sending}
                onRecorded={(file) => {
                  setAttachment({ kind: "new", file });
                  setAttachNote(null);
                }}
              />
            )}
            <div className="flex flex-col gap-2">
              <PackagePicker
                openUpward
                align="left"
                onSelect={(text) => setBody((prev) => (prev.trim() ? `${prev}\n\n${text}` : text))}
              />
              {/* On the official line the CRM's own templates are the wrong
                  thing to offer: Meta refuses free text to a guest who has
                  been quiet for 24 hours, and only an approved template gets
                  through. Same button, Meta's templates, sent as templates. */}
              {selected?.integration === "cloud_api" ? (
                <MetaTemplatePicker
                  numberId={numberId}
                  guestName={guestName ?? null}
                  openUpward
                  align="left"
                  disabled={sending}
                  onSend={sendTemplate}
                  uploadHeaderImage={uploadHeaderImage}
                />
              ) : (
                <TemplatePicker
                  channel="whatsapp"
                  openUpward
                  align="left"
                  onSelect={(t) => setBody(personalizeTemplate(t.body, { name: guestName, gender: guestGender }))}
                />
              )}
            </div>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write a WhatsApp message…"
              className="min-h-[64px] flex-1"
            />
            <Button onClick={send} disabled={sending || (!body.trim() && !attachment)} className="shrink-0">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          {meta && !meta.guestPhone
            ? "Add a phone number to this guest to start a WhatsApp conversation."
            : meta && meta.numberOptions.length === 0
              ? (
                <span className="inline-flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {/* Two different problems with the same empty picker: only an
                      admin can fix either, but they fix them in different places. */}
                  {meta.restrictedToNumbers
                    ? "None of the WhatsApp numbers you're assigned to is connected — ask an admin to reconnect it or change your numbers on the Users page."
                    : "No connected WhatsApp numbers — onboard one from WhatsApp Numbers (admin)."}
                </span>
              )
              : "WhatsApp sending isn't available for your role yet."}
        </p>
      )}

      <Dialog
        open={!!numberWarning}
        onClose={() => setNumberWarning(null)}
        title="This guest knows you on a different number"
        className="md:max-w-md"
      >
        <div className="p-4 md:p-5">
          <p className="text-sm text-muted-foreground">
            You&apos;ve been talking to{" "}
            <span className="font-medium text-foreground">{guestName}</span> on{" "}
            <span className="font-medium text-foreground">{numberWarning?.from}</span>. This
            message would reach them from{" "}
            <span className="font-medium text-foreground">{numberWarning?.to}</span> — a number
            they have never seen you use.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            To them it arrives as an unknown sender, so it often gets ignored or reported. It
            also splits the conversation across two threads on their phone.
          </p>

          <div className="mt-4 flex flex-col gap-2">
            {established?.selectable && (
              <Button
                onClick={() => {
                  setNumberId(established.id);
                  setNumberWarning(null);
                }}
              >
                Send from {numberWarning?.from} instead
              </Button>
            )}
            <Button variant="outline" onClick={() => void doSend()}>
              Send from {numberWarning?.to} anyway
            </Button>
            <Button variant="ghost" onClick={() => setNumberWarning(null)}>
              Cancel
            </Button>
          </div>

          {established && !established.selectable && (
            <p className="mt-3 text-xs text-muted-foreground">
              {numberWarning?.from} isn&apos;t connected right now, so you can&apos;t reply from
              it. Reconnecting it keeps the conversation in one place.
            </p>
          )}
        </div>
      </Dialog>
    </div>
  );
}
