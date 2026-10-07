"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Reply, Trash2, Paperclip, X } from "lucide-react";
import { Card, Button, Input, Badge, Textarea, RichTextEditor } from "@/components/ui";
import { uploadLibraryImage } from "@/components/messaging/upload-library-image";
import { htmlToPlainText } from "@/lib/message-templates";
import { LibraryFileField, type LibraryFile } from "@/components/messaging/library-file-field";
import { api } from "@/lib/client";

interface EmailAutoReplyDTO {
  id: string;
  mailboxId: string;
  subjectTerms: string[];
  bodyTerms: string[];
  termMatch: "any" | "all";
  subject: string | null;
  replyText: string;
  attachmentDocumentIds: string[];
  tagOnMatch: string | null;
  attachments: LibraryFile[];
  enabled: boolean;
  activeFromMin: number | null;
  activeToMin: number | null;
}

/**
 * Trigger-word auto-replies for inbound email — the same idea as the
 * WhatsApp ones, configured the same way.
 *
 * The loop guards live on the server (lib/email-autoreply.ts) and are not
 * configurable here on purpose: they are what makes the feature safe, and a
 * checkbox that turned them off would eventually get ticked.
 */
export function EmailAutoReplySection({ canManage }: { canManage: boolean }) {
  const [rules, setRules] = useState<EmailAutoReplyDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ items: EmailAutoReplyDTO[] }>("/api/admin/email-autoreplies");
      setRules(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load auto-replies");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(rule: EmailAutoReplyDTO) {
    setRules((rs) => rs?.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)) ?? null);
    try {
      await api.patch(`/api/admin/email-autoreplies/${rule.id}`, { enabled: !rule.enabled });
    } catch {
      load();
    }
  }

  async function remove(id: string) {
    try {
      await api.delete(`/api/admin/email-autoreplies/${id}`);
      setRules((rs) => rs?.filter((r) => r.id !== id) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  return (
    <Card className="p-4 md:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Reply className="h-4 w-4 text-brand-600" />
          <h2 className="text-sm font-semibold text-foreground">Email auto-replies</h2>
        </div>
        {canManage && !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add rule
          </Button>
        )}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        When an inbound email contains the trigger word, the CRM replies automatically. Never
        fires for mail from our own address, bounces, no-reply senders or anything already
        machine-generated, and answers the same person at most once every 6 hours.
      </p>

      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}

      {rules === null ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map((r) => (
            <div key={r.id} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {r.subjectTerms.length === 0 && r.bodyTerms.length === 0 && (
                      <Badge className="bg-secondary text-muted-foreground">Any message</Badge>
                    )}
                    {r.subjectTerms.map((t) => (
                      <Badge key={`s-${t}`} className="bg-brand-50 text-brand-800">
                        subject: {t}
                      </Badge>
                    ))}
                    {r.bodyTerms.map((t) => (
                      <Badge key={`b-${t}`} className="bg-indigo-50 text-indigo-800">
                        body: {t}
                      </Badge>
                    ))}
                    {r.subjectTerms.length + r.bodyTerms.length > 1 && (
                      <Badge className="bg-secondary text-muted-foreground">
                        {r.termMatch === "all" ? "all must match" : "any can match"}
                      </Badge>
                    )}
                    <Badge className="bg-secondary text-muted-foreground">{r.mailboxId}</Badge>
                    {r.tagOnMatch && (
                      <Badge className="bg-emerald-50 text-emerald-800" title="Added to the lead whenever this rule matches">
                        tags lead: {r.tagOnMatch}
                      </Badge>
                    )}
                    {!r.enabled && <Badge className="bg-secondary text-muted-foreground">Off</Badge>}
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground">{htmlToPlainText(r.replyText)}</p>
                  {r.attachments.length > 0 && (
                    <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      <Paperclip className="h-3 w-3" />
                      {r.attachments.map((a) => a.filename).join(", ")}
                    </p>
                  )}
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-2">
                    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        onChange={() => toggle(r)}
                        className="h-3.5 w-3.5 rounded border-input accent-brand-600"
                      />
                      On
                    </label>
                    <Button size="sm" variant="ghost" onClick={() => remove(r.id)}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {rules.length === 0 && !adding && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No email auto-replies yet.
            </p>
          )}
          {adding && (
            <NewRuleForm
              onCancel={() => setAdding(false)}
              onCreated={(r) => {
                setRules((rs) => [...(rs ?? []), r]);
                setAdding(false);
              }}
            />
          )}
        </div>
      )}
    </Card>
  );
}

function NewRuleForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (r: EmailAutoReplyDTO) => void;
}) {
  const [mailboxId, setMailboxId] = useState("sales");
  // One term per line rather than comma-separated: a term can be a URL, and
  // URLs contain commas often enough that splitting on them would quietly
  // break a rule.
  const [subjectTermsText, setSubjectTermsText] = useState("");
  const [bodyTermsText, setBodyTermsText] = useState("");
  const [termMatch, setTermMatch] = useState<"any" | "all">("any");
  const [subject, setSubject] = useState("");
  const [replyText, setReplyText] = useState("");
  const [tagOnMatch, setTagOnMatch] = useState("");
  // Several files, unlike WhatsApp's single attachment — an email can
  // reasonably carry a brochure and a rate card at once.
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!htmlToPlainText(replyText)) return;
    setSaving(true);
    setError(null);
    try {
      const created = await api.post<EmailAutoReplyDTO>("/api/admin/email-autoreplies", {
        mailboxId,
        subjectTerms: toTerms(subjectTermsText),
        bodyTerms: toTerms(bodyTermsText),
        termMatch,
        subject: subject.trim() || null,
        replyText: replyText.trim(),
        attachmentDocumentIds: files.map((f) => f.id),
        tagOnMatch: tagOnMatch.trim() || null,
      });
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50/40 p-3">
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Match in subject
          </label>
          <Textarea
            value={subjectTermsText}
            onChange={(e) => setSubjectTermsText(e.target.value)}
            rows={3}
            className="text-sm"
            placeholder={"brochure\npricing"}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Match in body
          </label>
          <Textarea
            value={bodyTermsText}
            onChange={(e) => setBodyTermsText(e.target.value)}
            rows={3}
            className="text-sm"
            placeholder={"trewellness.in/packages\nsingle occupancy"}
          />
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        One term per line — a term can be a word, a phrase or a URL, and is matched anywhere in
        that part of the email, ignoring case. Fill in both boxes to require both. Leave both
        empty for a catch-all that replies to anything no other rule matched.
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          When several terms are listed
          <select
            value={termMatch}
            onChange={(e) => setTermMatch(e.target.value as "any" | "all")}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
          >
            <option value="any">any can match</option>
            <option value="all">all must match</option>
          </select>
        </label>
        <label className="flex flex-1 items-center gap-1.5 text-xs text-muted-foreground">
          Reply subject
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Blank = Re: their subject"
            className="h-8 text-xs"
          />
        </label>
      </div>

      <label className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        Tag the lead
        <Input
          value={tagOnMatch}
          onChange={(e) => setTagOnMatch(e.target.value)}
          placeholder="Optional, e.g. Sample Itinerary EP"
          className="h-8 max-w-xs text-xs"
        />
      </label>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Added to the lead whenever this rule matches — even when the reply can&apos;t be sent, such as a
        form with no email address.
      </p>

      <label className="mb-1 mt-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Reply
      </label>
      <RichTextEditor
        html={replyText}
        onChange={setReplyText}
        onUploadImage={uploadLibraryImage}
        placeholder="Thanks for writing in — our brochure is attached. A member of the team will follow up shortly."
      />

      <div className="mt-2 space-y-1.5">
        {files.map((f) => (
          <div key={f.id} className="flex items-center gap-2 text-xs text-muted-foreground">
            <Paperclip className="h-3 w-3" />
            <span className="truncate">{f.filename}</span>
            <button
              type="button"
              onClick={() => setFiles((fs) => fs.filter((x) => x.id !== f.id))}
              className="text-destructive"
              aria-label={`Remove ${f.filename}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <LibraryFileField
          attachment={null}
          onChange={(id, file) => {
            // The picker holds one file at a time; each pick is appended so a
            // rule can carry several. Duplicates are dropped rather than sent
            // twice.
            if (id && file) setFiles((fs) => (fs.some((x) => x.id === id) ? fs : [...fs, file]));
          }}
        />
      </div>

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving || !htmlToPlainText(replyText)}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save &amp; enable
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <select
          value={mailboxId}
          onChange={(e) => setMailboxId(e.target.value)}
          className="ml-auto rounded-md border border-input bg-background px-2 py-1 text-xs"
        >
          <option value="sales">Sales mailbox</option>
          <option value="doctor">Doctor mailbox</option>
        </select>
      </div>
    </div>
  );
}

/** Split the editor's lines into terms. Newlines, not commas: a term can be a
 *  URL, and URLs carry commas often enough that comma-splitting would quietly
 *  break a rule. */
function toTerms(text: string): string[] {
  return [...new Set(text.split("\n").map((t) => t.trim()).filter(Boolean))];
}
