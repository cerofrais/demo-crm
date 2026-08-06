"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Plus, Loader2, Trash2, ShieldAlert } from "lucide-react";
import { Card, Badge, Button, Input, Textarea, Select, Dialog } from "@/components/ui";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";

interface AutoReplyDTO {
  id: string;
  numberId: string;
  triggerWord: string | null;
  replyText: string;
  enabled: boolean;
  createdAt: string;
}

interface WhatsAppNumberOption {
  id: string;
  label: string;
  phoneNumber: string | null;
}

export function AutoReplyManager({ canManage }: { canManage: boolean }) {
  const [autoReplies, setAutoReplies] = useState<AutoReplyDTO[]>([]);
  const [numbers, setNumbers] = useState<WhatsAppNumberOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<AutoReplyDTO | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [replies, nums] = await Promise.all([
        api.get<AutoReplyDTO[]>("/api/whatsapp/autoreplies"),
        api.get<WhatsAppNumberOption[]>("/api/admin/whatsapp/numbers"),
      ]);
      setAutoReplies(replies);
      setNumbers(nums);
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

  return (
    <div>
      <div className="flex items-center justify-between p-6 pb-0">
        <p className="text-xs text-muted-foreground">
          {autoReplies.length} auto-repl{autoReplies.length === 1 ? "y" : "ies"}
        </p>
        {canManage && (
          <Button onClick={() => setCreateOpen(true)} className="gap-1.5" disabled={!numbers.length}>
            <Plus className="h-4 w-4" /> New auto-reply
          </Button>
        )}
      </div>

      <div className="p-6">
        <Card className="overflow-hidden">
          {loading && !autoReplies.length ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Bot className="mr-2 h-5 w-5 animate-pulse" /> Loading auto-replies…
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
              <ShieldAlert className="h-10 w-10 opacity-30" />
              <p className="max-w-md text-sm">{error}</p>
              <Button size="sm" variant="outline" onClick={load}>Retry</Button>
            </div>
          ) : !autoReplies.length ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
              <Bot className="h-10 w-10 opacity-20" />
              <p>No auto-replies configured yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40">
                  <tr>
                    {["Number", "Trigger", "Reply", "Status", ""].map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {autoReplies.map((a) => (
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
                      </td>
                      <td className="px-3 py-2.5">
                        <button
                          onClick={() => toggleEnabled(a)}
                          disabled={!canManage}
                          title={
                            canManage
                              ? (a.enabled ? "On — click to turn off" : "Off — click to turn on")
                              : undefined
                          }
                          className={cn(
                            "rounded px-1.5 py-0.5 text-xs font-medium",
                            a.enabled ? "bg-brand-100 text-brand-700" : "bg-gray-100 text-gray-500",
                            !canManage && "cursor-default",
                          )}
                        >
                          {a.enabled ? "On" : "Off"}
                        </button>
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
      </div>

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
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="New auto-reply" className="md:max-w-sm">
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
