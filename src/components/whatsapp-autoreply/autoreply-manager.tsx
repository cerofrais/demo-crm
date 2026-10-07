"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Plus, Loader2, Trash2, ShieldAlert, Sparkles, Mail, Clock, CalendarClock, Paperclip, X, Tag as TagIcon } from "lucide-react";
import { Card, Badge, Button, Input, Textarea, Select, Dialog } from "@/components/ui";
import { LibraryFileField, type LibraryFile } from "@/components/messaging/library-file-field";
import { EmailAutoReplySection } from "@/components/message-templates/email-autoreply-section";
import { formatTag, slugifyTag } from "@/lib/lead-tags";
import { api } from "@/lib/client";
import { cn, formatIST } from "@/lib/utils";

interface AutoReplyDTO {
  id: string;
  numberId: string;
  kind: "trigger" | "welcome";
  triggerWord: string | null;
  replyText: string;
  enabled: boolean;
  activeFromMin: number | null;
  activeToMin: number | null;
  attachmentDocumentId: string | null;
  attachment: LibraryFile | null;
  createdAt: string;
}

interface WelcomeEmailDTO {
  enabled: boolean;
  subject: string;
  body: string;
  activeFromMin: number | null;
  activeToMin: number | null;
  attachmentDocumentId: string | null;
  attachment: LibraryFile | null;
  fromAddress: string | null;
}

interface AutoTagDTO {
  id: string;
  numberId: string;
  trigger: string;
  tag: string;
  enabled: boolean;
}

interface WhatsAppNumberOption {
  id: string;
  label: string;
  phoneNumber: string | null;
}

// ---------------------------------------------------------------------------
// Schedule helpers — minutes-since-midnight IST <-> the time input's "HH:MM"
// ---------------------------------------------------------------------------

function minToTime(min: number | null): string {
  if (min == null) return "";
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function timeToMin(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function scheduleLabel(fromMin: number | null, toMin: number | null): string {
  if (fromMin == null || toMin == null) return "Always on";
  const wrap = fromMin > toMin ? " (overnight)" : "";
  return `${minToTime(fromMin)}–${minToTime(toMin)} IST${wrap}`;
}

/** Two time pickers for the daily IST active window. Both-or-neither: a
 *  half-filled window is sent as null/null (always on) — the server treats
 *  a half-set window the same way, so the UI never lies about behavior. */
function ScheduleFields({
  fromMin, toMin, disabled, onChange,
}: {
  fromMin: number | null;
  toMin: number | null;
  disabled?: boolean;
  onChange: (fromMin: number | null, toMin: number | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Clock className="h-3.5 w-3.5" />
      <span>Active</span>
      <Input
        type="time"
        value={minToTime(fromMin)}
        disabled={disabled}
        onChange={(e) => onChange(timeToMin(e.target.value), toMin)}
        className="h-7 w-28 text-xs"
        aria-label="Active from (IST)"
      />
      <span>to</span>
      <Input
        type="time"
        value={minToTime(toMin)}
        disabled={disabled}
        onChange={(e) => onChange(fromMin, timeToMin(e.target.value))}
        className="h-7 w-28 text-xs"
        aria-label="Active until (IST)"
      />
      <span>IST — leave both empty for round-the-clock. End before start runs overnight.</span>
      {(fromMin != null || toMin != null) && !disabled && (
        <button
          type="button"
          onClick={() => onChange(null, null)}
          className="font-medium underline-offset-2 hover:underline"
        >
          Clear
        </button>
      )}
    </div>
  );
}


/** null out a half-set window so what's saved matches what the server does. */
function normalizeSchedule(fromMin: number | null, toMin: number | null): { activeFromMin: number | null; activeToMin: number | null } {
  const complete = fromMin != null && toMin != null;
  return { activeFromMin: complete ? fromMin : null, activeToMin: complete ? toMin : null };
}

export function AutoReplyManager({
  canManage,
  canManageEmail,
}: {
  canManage: boolean;
  /** Email rules have their own write permission — see the page. */
  canManageEmail: boolean;
}) {
  const [autoReplies, setAutoReplies] = useState<AutoReplyDTO[]>([]);
  const [numbers, setNumbers] = useState<WhatsAppNumberOption[]>([]);
  const [emailWelcome, setEmailWelcome] = useState<WelcomeEmailDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<AutoReplyDTO | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [replies, nums, email] = await Promise.all([
        api.get<AutoReplyDTO[]>("/api/whatsapp/autoreplies"),
        api.get<WhatsAppNumberOption[]>("/api/admin/whatsapp/numbers"),
        api.get<WelcomeEmailDTO>("/api/email-welcome"),
      ]);
      setAutoReplies(replies);
      setNumbers(nums);
      setEmailWelcome(email);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load auto-replies");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const numberLabel = (numberId: string) => {
    const n = numbers.find((x) => x.id === numberId);
    return n ? `${n.label}${n.phoneNumber ? ` (${n.phoneNumber})` : ""}` : "Unknown number";
  };

  const triggerReplies = autoReplies.filter((a) => a.kind === "trigger");
  const welcomeByNumber = new Map(
    autoReplies.filter((a) => a.kind === "welcome").map((a) => [a.numberId, a]),
  );

  async function toggleEnabled(a: AutoReplyDTO) {
    if (!canManage) return;
    setAutoReplies((prev) => prev.map((x) => (x.id === a.id ? { ...x, enabled: !x.enabled } : x)));
    try {
      await api.patch(`/api/whatsapp/autoreplies/${a.id}`, { enabled: !a.enabled });
    } catch {
      load();
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    await api.delete(`/api/whatsapp/autoreplies/${deleting.id}`);
    setDeleting(null);
    load();
  }

  if (loading && !autoReplies.length && !emailWelcome) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Bot className="mr-2 h-5 w-5 animate-pulse" /> Loading auto-replies…
      </div>
    );
  }

  if (error && !autoReplies.length && !emailWelcome) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
        <ShieldAlert className="h-10 w-10 opacity-30" />
        <p className="max-w-md text-sm">{error}</p>
        <Button size="sm" variant="outline" onClick={load}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-4 md:p-6">
      {/* ------------------------------------------------------------------ */}
      {/* WhatsApp welcome for brand-new numbers, one per number             */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Welcome message — new WhatsApp customers</h3>
            <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
              Sent once, to the first message from a number the CRM has never seen before. Not
              trigger-based — a new customer gets this instead of any trigger reply below, so
              they&apos;re never double-messaged. Each number has its own.
            </p>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          {numbers.length === 0 && (
            <p className="text-xs text-muted-foreground">No WhatsApp numbers connected yet.</p>
          )}
          {numbers.map((n) => (
            <WelcomeReplyCard
              key={n.id}
              number={n}
              existing={welcomeByNumber.get(n.id) ?? null}
              canManage={canManage}
              onToggle={toggleEnabled}
              onSaved={load}
            />
          ))}
        </div>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Onboarding welcome email                                           */}
      {/* ------------------------------------------------------------------ */}
      {emailWelcome && (
        <EmailWelcomeSection
          setting={emailWelcome}
          canManage={canManage}
          onSaved={(next) => setEmailWelcome(next)}
        />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Trigger-based replies (the original table)                         */}
      {/* ------------------------------------------------------------------ */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between p-5 pb-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Trigger-based replies</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {triggerReplies.length} auto-repl{triggerReplies.length === 1 ? "y" : "ies"}, keyed off
              a trigger word or sent for every inbound message.
            </p>
          </div>
          {canManage && (
            <Button onClick={() => setCreateOpen(true)} className="gap-1.5" disabled={!numbers.length}>
              <Plus className="h-4 w-4" /> New auto-reply
            </Button>
          )}
        </div>

        {!triggerReplies.length ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
            <Bot className="h-10 w-10 opacity-20" />
            <p>No trigger-based auto-replies configured yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40">
                <tr>
                  {["Number", "Trigger", "Reply", "Schedule", "Status", ""].map((h) => (
                    <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {triggerReplies.map((a) => (
                  <tr key={a.id} className="hover:bg-muted/20">
                    <td className="px-3 py-2.5 font-medium">{numberLabel(a.numberId)}</td>
                    <td className="px-3 py-2.5">
                      {a.triggerWord ? (
                        <Badge className="bg-brand-100 text-brand-700">{a.triggerWord}</Badge>
                      ) : (
                        <Badge className="bg-secondary text-secondary-foreground">All messages</Badge>
                      )}
                    </td>
                    <td className="max-w-sm truncate px-3 py-2.5 text-xs text-muted-foreground" title={a.replyText}>
                      {a.replyText}
                      {a.attachment && (
                        <span className="ml-1.5 inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-foreground">
                          <Paperclip className="h-3 w-3" />
                          {a.attachment.filename}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">
                      {scheduleLabel(a.activeFromMin, a.activeToMin)}
                    </td>
                    <td className="px-3 py-2.5">
                      <OnOffButton enabled={a.enabled} canManage={canManage} onClick={() => toggleEnabled(a)} />
                    </td>
                    <td className="px-3 py-2.5">
                      {canManage && (
                        <button
                          onClick={() => setDeleting(a)}
                          className="text-muted-foreground hover:text-destructive"
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Trigger-based replies for INBOUND EMAIL                            */}
      {/* Beside the WhatsApp ones rather than on the templates page, so      */}
      {/* every automatic reply the CRM sends is configured in one place.     */}
      {/* ------------------------------------------------------------------ */}
      <EmailAutoReplySection canManage={canManageEmail} />

      <AutoTagSection numbers={numbers} canManage={canManage} />
      <ScheduledTagSection numbers={numbers} canManage={canManage} />

      <EmailAutoTagSection canManage={canManageEmail} />

      {createOpen && (
        <AddAutoReplyModal
          numbers={numbers}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); load(); }}
        />
      )}

      {deleting && (
        <ConfirmDeleteModal
          numberLabel={numberLabel(deleting.numberId)}
          triggerWord={deleting.triggerWord}
          onCancel={() => setDeleting(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

function OnOffButton({
  enabled, canManage, onClick,
}: {
  enabled: boolean;
  canManage: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!canManage}
      title={canManage ? (enabled ? "On — click to turn off" : "Off — click to turn on") : undefined}
      className={cn(
        "rounded px-1.5 py-0.5 text-xs font-medium",
        enabled ? "bg-brand-100 text-brand-700" : "bg-gray-100 text-gray-500",
        !canManage && "cursor-default",
      )}
    >
      {enabled ? "On" : "Off"}
    </button>
  );
}

/** One number's welcome message — created lazily on first save, edited via
 *  PATCH afterwards. */
function WelcomeReplyCard({
  number, existing, canManage, onToggle, onSaved,
}: {
  number: WhatsAppNumberOption;
  existing: AutoReplyDTO | null;
  canManage: boolean;
  onToggle: (a: AutoReplyDTO) => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(existing?.replyText ?? "");
  const [fromMin, setFromMin] = useState<number | null>(existing?.activeFromMin ?? null);
  const [toMin, setToMin] = useState<number | null>(existing?.activeToMin ?? null);
  const [attachId, setAttachId] = useState<string | null>(existing?.attachmentDocumentId ?? null);
  const [attachFile, setAttachFile] = useState<LibraryFile | null>(existing?.attachment ?? null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refresh local draft when the server row changes (e.g. after reload).
  useEffect(() => {
    setText(existing?.replyText ?? "");
    setFromMin(existing?.activeFromMin ?? null);
    setToMin(existing?.activeToMin ?? null);
    setAttachId(existing?.attachmentDocumentId ?? null);
    setAttachFile(existing?.attachment ?? null);
  }, [existing?.id, existing?.replyText, existing?.activeFromMin, existing?.activeToMin, existing?.attachmentDocumentId, existing?.attachment]);

  const dirty =
    text.trim() !== (existing?.replyText ?? "") ||
    fromMin !== (existing?.activeFromMin ?? null) ||
    toMin !== (existing?.activeToMin ?? null) ||
    attachId !== (existing?.attachmentDocumentId ?? null);

  async function save() {
    if (!text.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const schedule = normalizeSchedule(fromMin, toMin);
      if (existing) {
        await api.patch(`/api/whatsapp/autoreplies/${existing.id}`, {
          replyText: text.trim(),
          attachmentDocumentId: attachId,
          ...schedule,
        });
      } else {
        await api.post("/api/whatsapp/autoreplies", {
          numberId: number.id,
          kind: "welcome",
          replyText: text.trim(),
          attachmentDocumentId: attachId,
          ...schedule,
        });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">
          {number.label}
          {number.phoneNumber && <span className="ml-1.5 text-xs text-muted-foreground">{number.phoneNumber}</span>}
        </p>
        {existing ? (
          <OnOffButton enabled={existing.enabled} canManage={canManage} onClick={() => onToggle(existing)} />
        ) : (
          <Badge className="bg-secondary text-xs text-secondary-foreground">Not set up</Badge>
        )}
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={!canManage}
        rows={3}
        className="mt-2 text-sm"
        placeholder={"Hello! \u{1F33F} Welcome to Trē — thanks for reaching out. We'll get back to you shortly!"}
      />
      <div className="mt-2 space-y-1.5">
        <ScheduleFields fromMin={fromMin} toMin={toMin} disabled={!canManage} onChange={(f, t) => { setFromMin(f); setToMin(t); }} />
        <LibraryFileField
          attachment={attachFile}
          disabled={!canManage}
          onChange={(id, file) => { setAttachId(id); setAttachFile(file); }}
        />
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {canManage && (
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={saving || !text.trim() || (!dirty && !!existing)}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {existing ? "Save" : "Save & enable"}
          </Button>
          {saved && <span className="text-xs text-emerald-600">Saved</span>}
        </div>
      )}
    </div>
  );
}

function EmailWelcomeSection({
  setting, canManage, onSaved,
}: {
  setting: WelcomeEmailDTO;
  canManage: boolean;
  onSaved: (next: WelcomeEmailDTO) => void;
}) {
  const [subject, setSubject] = useState(setting.subject);
  const [body, setBody] = useState(setting.body);
  const [enabled, setEnabled] = useState(setting.enabled);
  const [fromMin, setFromMin] = useState<number | null>(setting.activeFromMin);
  const [toMin, setToMin] = useState<number | null>(setting.activeToMin);
  const [attachId, setAttachId] = useState<string | null>(setting.attachmentDocumentId);
  const [attachFile, setAttachFile] = useState<LibraryFile | null>(setting.attachment);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(nextEnabled = enabled) {
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<WelcomeEmailDTO>("/api/email-welcome", {
        enabled: nextEnabled,
        subject: subject.trim(),
        body: body.trim(),
        attachmentDocumentId: attachId,
        ...normalizeSchedule(fromMin, toMin),
      });
      onSaved(next);
      setEnabled(next.enabled);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700">
            <Mail className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Welcome email — new guests</h3>
            <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
              Sent once, when a new guest&apos;s email address first enters the CRM (an unknown sender
              emailing in, or a website/medical form submission)
              {setting.fromAddress ? <> — from <span className="font-medium">{setting.fromAddress}</span></> : null}.
              Supports {"{name}"} and {"{salutation}"}.
            </p>
          </div>
        </div>
        <OnOffButton
          enabled={enabled}
          canManage={canManage && !saving}
          onClick={() => { if (subject.trim() && body.trim()) save(!enabled); }}
        />
      </div>

      <div className="mt-3 space-y-2">
        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={!canManage}
          placeholder="Subject"
          className="text-sm"
        />
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={!canManage}
          rows={5}
          className="text-sm"
        />
        <ScheduleFields fromMin={fromMin} toMin={toMin} disabled={!canManage} onChange={(f, t) => { setFromMin(f); setToMin(t); }} />
        <LibraryFileField
          attachment={attachFile}
          disabled={!canManage}
          onChange={(id, file) => { setAttachId(id); setAttachFile(file); }}
        />
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {canManage && (
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" onClick={() => save()} disabled={saving || !subject.trim() || !body.trim()}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
          {saved && <span className="text-xs text-emerald-600">Saved</span>}
        </div>
      )}
    </Card>
  );
}

function AddAutoReplyModal({
  numbers, onClose, onCreated,
}: {
  numbers: WhatsAppNumberOption[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [numberId, setNumberId] = useState(numbers[0]?.id ?? "");
  const [triggerWord, setTriggerWord] = useState("");
  const [replyText, setReplyText] = useState("");
  const [fromMin, setFromMin] = useState<number | null>(null);
  const [toMin, setToMin] = useState<number | null>(null);
  const [attachId, setAttachId] = useState<string | null>(null);
  const [attachFile, setAttachFile] = useState<LibraryFile | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = numberId && replyText.trim();

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/whatsapp/autoreplies", {
        numberId,
        triggerWord: triggerWord.trim() || null,
        replyText: replyText.trim(),
        attachmentDocumentId: attachId,
        ...normalizeSchedule(fromMin, toMin),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="New auto-reply" className="md:max-w-xl">
      <div className="space-y-3 p-4 md:p-5">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Number</span>
          <Select value={numberId} onChange={(e) => setNumberId(e.target.value)}>
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}{n.phoneNumber ? ` (${n.phoneNumber})` : ""}
              </option>
            ))}
          </Select>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Trigger word</span>
          <Input
            value={triggerWord}
            onChange={(e) => setTriggerWord(e.target.value)}
            placeholder="Leave blank to reply to every message"
          />
          <span className="block text-[11px] text-muted-foreground">
            Fires when this word appears anywhere in the guest&apos;s message. Blank replies to all of them.
          </span>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Reply text</span>
          <Textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            rows={4}
            placeholder="Thanks for reaching out — we'll get back to you shortly."
          />
        </label>

        <ScheduleFields fromMin={fromMin} toMin={toMin} onChange={(f, t) => { setFromMin(f); setToMin(t); }} />
        <LibraryFileField
          attachment={attachFile}
          onChange={(id, file) => { setAttachId(id); setAttachFile(file); }}
        />

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={!canSave || saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Create
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ConfirmDeleteModal({
  numberLabel, triggerWord, onCancel, onConfirm,
}: {
  numberLabel: string;
  triggerWord: string | null;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onClose={onCancel} title="Delete auto-reply" className="md:max-w-sm">
      <div className="p-4 md:p-5">
        <p className="text-sm text-muted-foreground">
          Delete the {triggerWord ? `"${triggerWord}"` : "catch-all"} auto-reply on {numberLabel}? This can&apos;t be undone.
        </p>
        {error && (
          <p className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Delete failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Delete
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Auto-tagging — put a tag on a lead when an inbound message contains a word
 * or a whole sentence.
 *
 * Sits beside the reply rules because it's configured the same way, but it's
 * independent of them: a message can trigger a reply, earn several tags, or
 * both. Unlike a reply (one winner), EVERY matching rule applies — "price for
 * a couple?" can be both price-asked and double-occupancy.
 */
function AutoTagSection({
  numbers, canManage,
}: {
  numbers: WhatsAppNumberOption[];
  canManage: boolean;
}) {
  const [rules, setRules] = useState<AutoTagDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [numberId, setNumberId] = useState("");
  const [trigger, setTrigger] = useState("");
  const [tag, setTag] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRules(await api.get<AutoTagDTO[]>("/api/whatsapp/autotags"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load auto-tags");
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setNumberId((cur) => cur || numbers[0]?.id || "");
  }, [numbers]);

  async function add() {
    if (!numberId || !trigger.trim() || !tag.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/whatsapp/autotags", { numberId, trigger: trigger.trim(), tag: tag.trim() });
      setTrigger("");
      setTag("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that rule");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(r: AutoTagDTO) {
    if (!canManage) return;
    setRules((prev) => prev?.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)) ?? prev);
    try {
      await api.patch(`/api/whatsapp/autotags/${r.id}`, { enabled: !r.enabled });
    } catch {
      load();
    }
  }

  async function remove(r: AutoTagDTO) {
    await api.delete(`/api/whatsapp/autotags/${r.id}`).catch(() => {});
    load();
  }

  const numberLabel = (id: string) => {
    const n = numbers.find((x) => x.id === id);
    return n ? `${n.label}${n.phoneNumber ? ` (${n.phoneNumber})` : ""}` : "Unknown number";
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 p-5 pb-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700">
          <TagIcon className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">WhatsApp auto-tagging</h3>
          <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
            Tag a lead automatically from what the guest says. Enter a word or a whole
            sentence — it matches anywhere in their message, ignoring case. Every rule that
            matches applies, so one message can earn several tags. Tags land on the lead and
            work with the filters on the board, tasks and reports.
          </p>
        </div>
      </div>

      {error && <p className="px-5 pb-2 text-xs text-destructive">{error}</p>}

      {rules === null ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : rules.length === 0 ? (
        <p className="px-5 pb-3 text-xs text-muted-foreground">No auto-tag rules yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40">
              <tr>
                {["Number", "When the message contains", "Tag", "Status", ""].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rules.map((r) => (
                <tr key={r.id} className="hover:bg-muted/20">
                  <td className="px-3 py-2.5 font-medium">{numberLabel(r.numberId)}</td>
                  <td className="max-w-sm px-3 py-2.5 text-xs text-muted-foreground">
                    <span className="break-words italic">&ldquo;{r.trigger}&rdquo;</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge className={formatTag(r.tag).className}>{formatTag(r.tag).label}</Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <OnOffButton enabled={r.enabled} canManage={canManage} onClick={() => toggle(r)} />
                  </td>
                  <td className="px-3 py-2.5">
                    {canManage && (
                      <button
                        onClick={() => remove(r)}
                        className="text-muted-foreground hover:text-destructive"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && numbers.length > 0 && (
        <div className="flex flex-wrap items-end gap-2 border-t border-border p-3">
          <Select value={numberId} onChange={(e) => setNumberId(e.target.value)} className="h-9 w-52 text-xs">
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>{n.label}</option>
            ))}
          </Select>
          <Input
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
            placeholder="Word or sentence, e.g. single occupancy"
            className="h-9 min-w-[14rem] flex-1 text-xs"
          />
          <Input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Tag, e.g. Single Occupancy"
            className="h-9 w-48 text-xs"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          />
          <Button size="sm" onClick={add} disabled={saving || !trigger.trim() || !tag.trim()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add rule
          </Button>
          {tag.trim() && (
            <span className="text-[11px] text-muted-foreground">
              saved as <span className="font-medium text-foreground">{slugifyTag(tag)}</span>
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

interface ScheduledTagDTO {
  id: string;
  numberId: string;
  tag: string;
  label: string | null;
  startsAt: string;
  endsAt: string;
  enabled: boolean;
  state: "running" | "upcoming" | "finished" | "off";
}

const STATE_STYLE: Record<ScheduledTagDTO["state"], string> = {
  running: "bg-emerald-100 text-emerald-800",
  upcoming: "bg-sky-100 text-sky-800",
  finished: "bg-secondary text-muted-foreground",
  off: "bg-secondary text-muted-foreground",
};

/** A datetime-local input gives "2026-11-01T09:00" in LOCAL time, which is
 *  what the person typing it means; the Date it becomes is sent as UTC. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Campaign windows: tag everyone who writes to a number while one is open.
 *
 * The keyword rules above tag by what a guest says. This tags by when they
 * said anything at all, which is the only thing that works for an ad — people
 * answer a Diwali post with "hi", not with the word "Diwali".
 */
function ScheduledTagSection({
  numbers, canManage,
}: {
  numbers: WhatsAppNumberOption[];
  canManage: boolean;
}) {
  const [rules, setRules] = useState<ScheduledTagDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [numberId, setNumberId] = useState("");
  const [tag, setTag] = useState("");
  const [label, setLabel] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRules(await api.get<ScheduledTagDTO[]>("/api/whatsapp/scheduled-tags"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load scheduled tags");
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setNumberId((cur) => cur || numbers[0]?.id || ""); }, [numbers]);

  async function add() {
    if (!numberId || !tag.trim() || !startsAt || !endsAt) return;
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/whatsapp/scheduled-tags", {
        numberId,
        tag: tag.trim(),
        label: label.trim() || undefined,
        // Sent as an instant: the input is local time, which is what the
        // person meant, and the server stores UTC like every timestamp.
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
      });
      setTag("");
      setLabel("");
      setStartsAt("");
      setEndsAt("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that window");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(r: ScheduledTagDTO) {
    if (!canManage) return;
    setRules((prev) => prev?.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)) ?? prev);
    try {
      await api.patch(`/api/whatsapp/scheduled-tags/${r.id}`, { enabled: !r.enabled });
    } finally {
      load();
    }
  }

  async function remove(r: ScheduledTagDTO) {
    await api.delete(`/api/whatsapp/scheduled-tags/${r.id}`).catch(() => {});
    load();
  }

  const numberLabel = (id: string) => {
    const n = numbers.find((x) => x.id === id);
    return n ? `${n.label}${n.phoneNumber ? ` (${n.phoneNumber})` : ""}` : "Unknown number";
  };
  const when = (iso: string) =>
    formatIST(iso, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 p-5 pb-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <CalendarClock className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">Campaign windows</h3>
          <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
            Tag everyone who messages a number while a window is open, whatever they say — put the number on a post,
            open a window around it, and the leads it brings in carry the tag. No keyword, because people answer an ad
            with &ldquo;hi&rdquo;. Times are IST; both ends count.
          </p>
        </div>
      </div>

      {error && <p className="px-5 pb-2 text-xs text-destructive">{error}</p>}

      {rules === null ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : rules.length === 0 ? (
        <p className="px-5 pb-3 text-xs text-muted-foreground">No campaign windows yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40">
              <tr>
                {["Number", "Window", "Tag", "Status", ""].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rules.map((r) => (
                <tr key={r.id} className="hover:bg-muted/20">
                  <td className="px-3 py-2.5 font-medium">{numberLabel(r.numberId)}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    <span className="whitespace-nowrap">{when(r.startsAt)} → {when(r.endsAt)}</span>
                    {r.label && <span className="block italic">{r.label}</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge className={formatTag(r.tag).className}>{formatTag(r.tag).label}</Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Badge className={cn("text-[10px] capitalize", STATE_STYLE[r.state])}>{r.state}</Badge>
                      <OnOffButton enabled={r.enabled} canManage={canManage} onClick={() => toggle(r)} />
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    {canManage && (
                      <button onClick={() => remove(r)} className="text-muted-foreground hover:text-destructive" title="Delete">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && numbers.length > 0 && (
        <div className="flex flex-wrap items-end gap-2 border-t border-border p-3">
          <Select value={numberId} onChange={(e) => setNumberId(e.target.value)} className="h-9 w-44 text-xs">
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>{n.label}</option>
            ))}
          </Select>
          <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
            From
            <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="h-9 w-48 text-xs" />
          </label>
          <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
            To
            <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="h-9 w-48 text-xs" />
          </label>
          <Input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Tag, e.g. Diwali Post"
            className="h-9 w-44 text-xs"
          />
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Note (optional)"
            className="h-9 w-40 text-xs"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          />
          <Button size="sm" onClick={add} disabled={saving || !tag.trim() || !startsAt || !endsAt}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add window
          </Button>
          {tag.trim() && (
            <span className="text-[11px] text-muted-foreground">
              saved as <span className="font-medium text-foreground">{slugifyTag(tag)}</span>
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

interface EmailAutoTagDTO {
  id: string;
  mailboxId: string;
  subjectTerms: string[];
  bodyTerms: string[];
  termMatch: "any" | "all";
  tag: string;
  enabled: boolean;
}

/** One term per line — a term can be a URL, and URLs carry commas. */
function linesToTerms(text: string): string[] {
  return [...new Set(text.split("\n").map((t) => t.trim()).filter(Boolean))];
}

/**
 * Email auto-tagging — the email sibling of the section above. Terms work
 * like the email auto-replies: a subject list and a body list, any/all
 * within a list, both lists required when both are filled. Every matching
 * rule applies. Quoted earlier emails in a reply are ignored, so a guest
 * isn't tagged from words in OUR email that their reply quotes.
 */
function EmailAutoTagSection({ canManage }: { canManage: boolean }) {
  const [rules, setRules] = useState<EmailAutoTagDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mailboxId, setMailboxId] = useState("sales");
  const [subjectText, setSubjectText] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [termMatch, setTermMatch] = useState<"any" | "all">("any");
  const [tag, setTag] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ items: EmailAutoTagDTO[] }>("/api/admin/email-autotags");
      setRules(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load email auto-tags");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const subjectTerms = linesToTerms(subjectText);
  const bodyTerms = linesToTerms(bodyText);
  const canAdd = Boolean(tag.trim()) && subjectTerms.length + bodyTerms.length > 0;

  async function add() {
    if (!canAdd) return;
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/admin/email-autotags", {
        mailboxId, subjectTerms, bodyTerms, termMatch, tag: tag.trim(),
      });
      setSubjectText("");
      setBodyText("");
      setTag("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that rule");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(r: EmailAutoTagDTO) {
    if (!canManage) return;
    setRules((prev) => prev?.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)) ?? prev);
    try {
      await api.patch(`/api/admin/email-autotags/${r.id}`, { enabled: !r.enabled });
    } catch {
      load();
    }
  }

  async function remove(r: EmailAutoTagDTO) {
    await api.delete(`/api/admin/email-autotags/${r.id}`).catch(() => {});
    load();
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 p-5 pb-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700">
          <Mail className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">Email auto-tagging</h3>
          <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
            Tag a lead automatically from an inbound email. List words, phrases or URLs to find in
            the subject, the body, or both — matched anywhere, ignoring case. Fill in both boxes to
            require both. Every rule that matches applies. Text quoted from an earlier email in a
            reply is ignored, so a guest isn&apos;t tagged from words in our own email.
          </p>
        </div>
      </div>

      {error && <p className="px-5 pb-2 text-xs text-destructive">{error}</p>}

      {rules === null ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : rules.length === 0 ? (
        <p className="px-5 pb-3 text-xs text-muted-foreground">No email auto-tag rules yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40">
              <tr>
                {["Mailbox", "When the email contains", "Tag", "Status", ""].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rules.map((r) => (
                <tr key={r.id} className="hover:bg-muted/20">
                  <td className="px-3 py-2.5 font-medium capitalize">{r.mailboxId}</td>
                  <td className="max-w-md px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1">
                      {r.subjectTerms.map((t) => (
                        <Badge key={`s-${t}`} className="bg-brand-50 text-brand-800">subject: {t}</Badge>
                      ))}
                      {r.bodyTerms.map((t) => (
                        <Badge key={`b-${t}`} className="max-w-full break-all bg-indigo-50 text-indigo-800">body: {t}</Badge>
                      ))}
                      {r.subjectTerms.length + r.bodyTerms.length > 1 && (
                        <Badge className="bg-secondary text-muted-foreground">
                          {r.termMatch === "all" ? "all must match" : "any can match"}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge className={formatTag(r.tag).className}>{formatTag(r.tag).label}</Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <OnOffButton enabled={r.enabled} canManage={canManage} onClick={() => toggle(r)} />
                  </td>
                  <td className="px-3 py-2.5">
                    {canManage && (
                      <button
                        onClick={() => remove(r)}
                        className="text-muted-foreground hover:text-destructive"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && (
        <div className="space-y-2 border-t border-border p-3">
          <div className="grid gap-2 md:grid-cols-2">
            <Textarea
              value={subjectText}
              onChange={(e) => setSubjectText(e.target.value)}
              rows={2}
              className="text-xs"
              placeholder={"Match in subject — one per line\ne.g. price"}
            />
            <Textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              rows={2}
              className="text-xs"
              placeholder={"Match in body — one per line\ne.g. single occupancy"}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)} className="h-9 w-40 text-xs">
              <option value="sales">Sales mailbox</option>
              <option value="doctor">Doctor mailbox</option>
            </Select>
            <Select
              value={termMatch}
              onChange={(e) => setTermMatch(e.target.value as "any" | "all")}
              className="h-9 w-40 text-xs"
              title="When several terms are listed"
            >
              <option value="any">any can match</option>
              <option value="all">all must match</option>
            </Select>
            <Input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="Tag, e.g. Price Asked"
              className="h-9 w-48 text-xs"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            />
            <Button size="sm" onClick={add} disabled={saving || !canAdd}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Add rule
            </Button>
            {tag.trim() && (
              <span className="text-[11px] text-muted-foreground">
                saved as <span className="font-medium text-foreground">{slugifyTag(tag)}</span>
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
