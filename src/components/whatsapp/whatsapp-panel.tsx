"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, ChevronUp, MessageCircle, AlertTriangle, Paperclip, X, FileText, Download, Pencil, Trash2, Check, CheckCheck } from "lucide-react";
import { Button, Textarea, Select, Badge } from "@/components/ui";
import { AudioRecordButton } from "@/components/ui/audio-record-button";
import { api } from "@/lib/client";
import { cn, formatIST } from "@/lib/utils";
import type { MessageDTO } from "@/lib/types";
import { TemplatePicker } from "@/components/messaging/template-picker";
import { PackagePicker } from "@/components/messaging/package-picker";
import { personalizeTemplate } from "@/lib/message-templates";

interface NumberOption {
  id: string;
  label: string;
  phoneNumber: string | null;
  isDefault: boolean;
  instanceName: string;
}

// Deterministic color per WhatsApp number, keyed off `instanceName` — the
// same value Message.mailboxId stores — so a number's dropdown color and its
// incoming messages' bubble color always match, with no lookup needed.
const NUMBER_COLOR_PALETTE = [
  { bg: "bg-sky-50", border: "border-sky-200", text: "text-sky-700", dot: "bg-sky-500", hex: "#0369a1" },
  { bg: "bg-violet-50", border: "border-violet-200", text: "text-violet-700", dot: "bg-violet-500", hex: "#6d28d9" },
  { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-700", dot: "bg-amber-500", hex: "#b45309" },
  { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-700", dot: "bg-emerald-500", hex: "#047857" },
  { bg: "bg-rose-50", border: "border-rose-200", text: "text-rose-700", dot: "bg-rose-500", hex: "#be123c" },
  { bg: "bg-indigo-50", border: "border-indigo-200", text: "text-indigo-700", dot: "bg-indigo-500", hex: "#4338ca" },
  { bg: "bg-orange-50", border: "border-orange-200", text: "text-orange-700", dot: "bg-orange-500", hex: "#c2410c" },
  { bg: "bg-cyan-50", border: "border-cyan-200", text: "text-cyan-700", dot: "bg-cyan-500", hex: "#0e7490" },
  { bg: "bg-pink-50", border: "border-pink-200", text: "text-pink-700", dot: "bg-pink-500", hex: "#be185d" },
  { bg: "bg-lime-50", border: "border-lime-200", text: "text-lime-700", dot: "bg-lime-500", hex: "#4d7c0f" },
];

function hashKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function numberColor(key: string | null | undefined) {
  if (!key) return null;
  return NUMBER_COLOR_PALETTE[hashKey(key) % NUMBER_COLOR_PALETTE.length];
}

interface ThreadResponse {
  items: MessageDTO[]; // newest-first
  nextCursor: string | null;
  guestPhone: string | null;
  canSend: boolean;
  numberOptions: NumberOption[];
  /** The number this conversation was last on, if any — the reply picker
   * should default to it instead of the org-wide default number. */
  suggestedNumberId: string | null;
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
 *  covers that) or an unrecognized status. */
function DeliveryTicks({ status }: { status: string }) {
  if (status === "read") return <CheckCheck className="h-3.5 w-3.5 shrink-0 text-brand-600" />;
  if (status === "delivered") return <CheckCheck className="h-3.5 w-3.5 shrink-0" />;
  if (status === "sent") return <Check className="h-3.5 w-3.5 shrink-0" />;
  return null;
}

function Attachment({ attachment }: { attachment: NonNullable<MessageDTO["attachment"]> }) {
  if (attachment.mimeType.startsWith("image/")) {
    return (
      <a href={`/api/files/${attachment.id}?inline=1`} target="_blank" rel="noopener noreferrer" className="block min-w-0">
        {/* w-auto max-w-full keeps a wide photo inside the 85% bubble instead of
            forcing the whole tab to scroll sideways; object-contain because
            object-cover is a no-op without a fixed width/height pair. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/files/${attachment.id}?inline=1`}
          alt={attachment.filename}
          className="mb-1 h-auto max-h-56 w-auto max-w-full rounded-md border border-border object-contain"
        />
      </a>
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
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const [uploadCategory, setUploadCategory] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [messageBusy, setMessageBusy] = useState<string | null>(null);

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
      setNumberId((prev) =>
        prev ||
        res.suggestedNumberId ||
        res.myNumberId ||
        res.numberOptions.find((n) => n.isDefault)?.id ||
        res.numberOptions[0]?.id ||
        "",
      );
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

  async function send() {
    if ((!body.trim() && !attachFile) || !numberId) return;
    setSending(true);
    setError(null);
    try {
      let attachmentDocumentId: string | undefined;
      if (attachFile && uploadCategory) {
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
      setBody("");
      setAttachFile(null);
      if (fileRef.current) fileRef.current.value = "";
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
        {meta && meta.numberOptions.length > 1 && (
          <div className="flex items-center gap-1.5">
            <span
              className={cn("h-2.5 w-2.5 shrink-0 rounded-full", numberColor(meta.numberOptions.find((n) => n.id === numberId)?.instanceName)?.dot)}
              title="This number's color also marks its incoming messages below"
            />
            <Select value={numberId} onChange={(e) => setNumberId(e.target.value)} className="w-36 lg:h-7 lg:text-xs">
              {meta.numberOptions.map((n) => (
                <option key={n.id} value={n.id} style={{ color: numberColor(n.instanceName)?.hex }}>
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
              const color = !outbound ? numberColor(m.mailboxId) : null;
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
                      {outbound && <DeliveryTicks status={m.status} />}
                      {m.status === "failed" && (
                        <Badge className="bg-destructive/10 text-destructive">Failed</Badge>
                      )}
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
                        {m.attachment && <Attachment attachment={m.attachment} />}
                        {m.body && <div className="whitespace-pre-wrap break-words text-foreground">{m.body}</div>}
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
          {attachFile && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 px-2.5 py-1.5 text-xs">
              <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{attachFile.name}</span>
              <span className="shrink-0 text-muted-foreground">{humanSize(attachFile.size)}</span>
              <button
                onClick={() => { setAttachFile(null); if (fileRef.current) fileRef.current.value = ""; }}
                className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                title="Remove attachment"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={(e) => setAttachFile(e.target.files?.[0] ?? null)}
            />
            {uploadCategory && (
              <Button
                variant="outline"
                size="icon"
                onClick={() => fileRef.current?.click()}
                disabled={sending || Boolean(attachFile)}
                title="Attach a photo, voice note, or document"
                type="button"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            )}
            {uploadCategory && !attachFile && (
              <AudioRecordButton
                disabled={sending}
                onRecorded={(file) => {
                  setAttachFile(file);
                  if (fileRef.current) fileRef.current.value = "";
                }}
              />
            )}
            <div className="flex flex-col gap-2">
              <PackagePicker
                openUpward
                align="left"
                onSelect={(text) => setBody((prev) => (prev.trim() ? `${prev}\n\n${text}` : text))}
              />
              <TemplatePicker
                channel="whatsapp"
                openUpward
                align="left"
                onSelect={(t) => setBody(personalizeTemplate(t.body, { name: guestName, gender: guestGender }))}
              />
            </div>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write a WhatsApp message…"
              className="min-h-[64px] flex-1"
            />
            <Button onClick={send} disabled={sending || (!body.trim() && !attachFile)} className="shrink-0">
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
                  <AlertTriangle className="h-3.5 w-3.5" /> No connected WhatsApp numbers — onboard one from WhatsApp Numbers (admin).
                </span>
              )
              : "WhatsApp sending isn't available for your role yet."}
        </p>
      )}
    </div>
  );
}
