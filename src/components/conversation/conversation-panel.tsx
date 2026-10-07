"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, ChevronUp, Mail, AlertTriangle, Paperclip, X, Maximize2 } from "lucide-react";
import { Button, Input, Select, Badge, Dialog, RichTextEditor } from "@/components/ui";
import { api } from "@/lib/client";
import { MessageBody } from "@/components/messaging/message-body";
import { cn, formatIST } from "@/lib/utils";
import type { MessageDTO } from "@/lib/types";
import { TemplatePicker } from "@/components/messaging/template-picker";
import { AttachmentPicker, type AttachmentSelection } from "@/components/messaging/attachment-picker";
import { personalizeTemplate, templateBodyToHtml } from "@/lib/message-templates";

interface ConversationResponse {
  items: MessageDTO[]; // newest-first
  nextCursor: string | null;
  activeMailbox: string;
  guestEmail: string | null;
  fromAddress: string | null;
  canSend: boolean;
  mailboxOptions: { id: string; label: string }[];
}

export function ConversationPanel({
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
  const [items, setItems] = useState<MessageDTO[]>([]); // chronological (oldest→newest)
  const [meta, setMeta] = useState<Omit<ConversationResponse, "items" | "nextCursor">>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [mailbox, setMailbox] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [attachment, setAttachment] = useState<AttachmentSelection | null>(null);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [uploadCategory, setUploadCategory] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .get<{ uploadable: string[] }>("/api/files/meta")
      .then((m) =>
        // Prefer "operational" (general-purpose) so a rep attaching a brochure
        // doesn't default to "medical" just because their role also has that
        // permission — falls back to whatever's available (e.g. Doctor-only
        // roles that only hold medical/consent).
        setUploadCategory(m.uploadable.includes("operational") ? "operational" : (m.uploadable[0] ?? null)),
      )
      .catch(() => {});
  }, []);

  const qs = useCallback(
    (cursor?: string) => {
      const p = new URLSearchParams();
      if (mailbox) p.set("mailbox", mailbox);
      if (cursor) p.set("cursor", cursor);
      return p.toString();
    },
    [mailbox],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<ConversationResponse>(
        `/api/guests/${guestId}/conversation?${qs()}`,
      );
      const { items: page, nextCursor: nc, ...rest } = res;
      setItems([...page].reverse()); // oldest→newest
      setNextCursor(nc);
      setMeta(rest);
      setTimeout(() => bottomRef.current?.scrollIntoView({ block: "end" }), 50);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load conversation");
    } finally {
      setLoading(false);
    }
  }, [guestId, qs]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadOlder() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await api.get<ConversationResponse>(
        `/api/guests/${guestId}/conversation?${qs(nextCursor)}`,
      );
      setItems((prev) => [...[...res.items].reverse(), ...prev]); // prepend older
      setNextCursor(res.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  async function uploadDocument(file: File, category: string): Promise<string> {
    const { url, storageKey } = await api.post<{ url: string; storageKey: string }>(
      "/api/files/upload-url",
      {
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        category,
        sizeBytes: file.size, // F39: bind the upload size into the presigned PUT
        guestId,
        ...(enquiryId ? { enquiryId } : {}),
      },
    );
    const put = await fetch(url, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);
    const confirmed = await api.post<{ id: string }>("/api/files/confirm", {
      storageKey,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      category,
      sizeBytes: file.size,
      guestId,
      ...(enquiryId ? { enquiryId } : {}),
    });
    return confirmed.id;
  }

  async function uploadInlineImage(file: File): Promise<string | null> {
    if (!uploadCategory) return null;
    try {
      return await uploadDocument(file, uploadCategory);
    } catch {
      return null;
    }
  }

  function htmlToPlainText(html: string): string {
    const div = document.createElement("div");
    div.innerHTML = html;
    return (div.innerText || div.textContent || "").trim();
  }

  async function send() {
    const plainBody = htmlToPlainText(bodyHtml);
    if (!plainBody) return;
    setSending(true);
    setError(null);
    try {
      let attachmentDocumentId: string | undefined;
      // An existing pick is already a Document — nothing to upload.
      if (attachment?.kind === "existing") {
        attachmentDocumentId = attachment.doc.id;
      } else if (attachment?.kind === "new" && uploadCategory) {
        attachmentDocumentId = await uploadDocument(attachment.file, uploadCategory);
      }

      const last = items[items.length - 1];
      const msg = await api.post<MessageDTO>("/api/messages/email", {
        guestId,
        enquiryId,
        subject: subject.trim() || undefined,
        body: plainBody,
        html: bodyHtml,
        inReplyToMessageId: last?.id,
        attachmentDocumentId,
      });
      setItems((prev) => [...prev, msg]);
      setBodyHtml("");
      setSubject("");
      setAttachment(null);
      setAttachNote(null);
      if (msg.status === "failed") setError("The email failed to send. Check mailbox settings.");
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 50);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex items-center justify-between gap-2 pb-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Mail className="h-3.5 w-3.5" />
          {meta?.guestEmail ? (
            <span>Email with <span className="font-medium text-foreground">{meta.guestEmail}</span></span>
          ) : (
            <span>No email on file for this guest</span>
          )}
        </div>
        {meta && meta.mailboxOptions.length > 1 && (
          <Select value={mailbox} onChange={(e) => setMailbox(e.target.value)} className="w-28 lg:h-7 lg:text-xs">
            <option value="">All</option>
            {meta.mailboxOptions.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </Select>
        )}
      </div>

      {/* thread — an equal flex-1 sibling of the compose block below splits
          the panel ~50/50 between them; scrolls internally so a long
          history doesn't eat into compose room. */}
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
              <p className="py-8 text-center text-sm text-muted-foreground">No emails yet.</p>
            )}
            {items.map((m) => {
              const outbound = m.direction === "outbound";
              // Names cover received attachments too, whose files aren't
              // stored; an older message may only have the linked document.
              const attachmentNames = m.attachmentNames?.length
                ? m.attachmentNames
                : m.attachment
                  ? [m.attachment.filename]
                  : [];
              return (
                <div key={m.id} className={cn("flex", outbound ? "justify-end" : "justify-start")}>
                  <div
                    className={cn(
                      "max-w-[85%] rounded-lg border px-3 py-2 text-sm shadow-sm",
                      outbound
                        ? "border-brand-200 bg-brand-50"
                        : "border-border bg-card",
                    )}
                  >
                    <div className="mb-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {outbound ? "You" : m.fromEmail ?? "Guest"}
                      </span>
                      <span>
                        {formatIST(m.createdAt, {
                          day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                        })}
                      </span>
                      {/* In the header as well as below the body, so a message
                          with an attachment stands out while scrolling. */}
                      {attachmentNames.length > 0 && (
                        <span
                          className="inline-flex items-center gap-0.5"
                          title={attachmentNames.join(", ")}
                          aria-label={`${attachmentNames.length} attachment${attachmentNames.length === 1 ? "" : "s"}`}
                        >
                          <Paperclip className="h-3 w-3" />
                          {attachmentNames.length > 1 && attachmentNames.length}
                        </span>
                      )}
                      {m.status === "failed" && (
                        <Badge className="bg-destructive/10 text-destructive">Failed</Badge>
                      )}
                      {m.needsReview && (
                        <span className="inline-flex items-center gap-0.5 text-amber-600">
                          <AlertTriangle className="h-3 w-3" /> review
                        </span>
                      )}
                    </div>
                    {m.subject && <div className="text-xs font-semibold text-foreground">{m.subject}</div>}
                    <MessageBody body={m.body} />
                    {attachmentNames.length > 0 && (
                      <div className="mt-1 flex items-start gap-1 text-[11px] text-muted-foreground">
                        <Paperclip className="mt-0.5 h-3 w-3 shrink-0" />
                        <span className="min-w-0 break-words">
                          {attachmentNames.map((name, i) => (
                            <span key={`${name}-${i}`}>
                              {i > 0 && ", "}
                              {/* Only a file the CRM holds can be opened from here;
                                  a received attachment is named, not stored. */}
                              {m.attachment && name === m.attachment.filename ? (
                                <a
                                  href={`/api/files/${m.attachment.id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="underline hover:text-foreground"
                                >
                                  {name}
                                </a>
                              ) : (
                                name
                              )}
                            </span>
                          ))}
                        </span>
                      </div>
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

      {/* compose — the other half of the panel (equal flex-1 with the
          thread above), so the textarea has real room instead of a
          4-line strip pinned to the bottom. */}
      {meta?.canSend ? (
        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2">
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject (optional — defaults to Re: …)"
            className="h-8 shrink-0 text-sm"
          />
          {attachment && (
            <div className="flex shrink-0 items-center gap-2 rounded-md border border-border bg-secondary/50 px-2.5 py-1.5 text-xs">
              <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {attachment.kind === "new" ? attachment.file.name : attachment.doc.filename}
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
            <p className="shrink-0 px-0.5 text-[11px] text-muted-foreground">{attachNote}</p>
          )}
          <div className="flex shrink-0 items-center gap-2">
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
            <TemplatePicker
              channel="email"
              openUpward
              align="left"
              onSelect={(t) => {
                if (t.subject) setSubject(personalizeTemplate(t.subject, { name: guestName, gender: guestGender }));
                setBodyHtml(templateBodyToHtml(personalizeTemplate(t.body, { name: guestName, gender: guestGender })));
              }}
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => setEditorOpen(true)}
              title="Open a bigger editor"
              type="button"
              className="ml-auto"
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          </div>
          <RichTextEditor
            html={bodyHtml}
            onChange={setBodyHtml}
            placeholder={`Write an email${meta.fromAddress ? ` from ${meta.fromAddress}` : ""}…`}
            disabled={sending}
            className="min-h-0 flex-1"
            onUploadImage={uploadCategory ? uploadInlineImage : undefined}
          />
          <div className="flex shrink-0 justify-end">
            <Button onClick={send} disabled={sending || !bodyHtml || bodyHtml === "<br>"}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          {meta && !meta.guestEmail
            ? "Add an email address to this guest to start a conversation."
            : "Email sending isn't available for your role/mailbox yet."}
        </p>
      )}

      {/* Full-screen editor — same subject/bodyHtml state, just a lot more
          room to work with. Nothing to save/discard: closing it keeps
          whatever's typed, same as collapsing back to the inline compose bar. */}
      <Dialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title="Compose email"
        className="md:max-w-2xl"
      >
        <div className="flex h-[70dvh] flex-col gap-2 p-4">
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject (optional — defaults to Re: …)"
          />
          <RichTextEditor
            html={bodyHtml}
            onChange={setBodyHtml}
            placeholder={`Write an email${meta?.fromAddress ? ` from ${meta.fromAddress}` : ""}…`}
            disabled={sending}
            className="min-h-0 flex-1"
            onUploadImage={uploadCategory ? uploadInlineImage : undefined}
          />
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="outline" onClick={() => setEditorOpen(false)}>
              Done
            </Button>
            <Button
              onClick={() => {
                setEditorOpen(false);
                send();
              }}
              disabled={sending || !bodyHtml || bodyHtml === "<br>"}
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
