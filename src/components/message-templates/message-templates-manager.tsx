"use client";

import { useCallback, useEffect, useState } from "react";
import { LayoutTemplate, Mail, MessageCircle, Plus, Pencil, Trash2, Loader2 } from "lucide-react";
import { Card, Badge, Button, Input, Textarea, Dialog } from "@/components/ui";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { MessageTemplateDTO, MessageTemplateChannel } from "@/lib/message-templates";

const CHANNEL_META: Record<MessageTemplateChannel, { label: string; icon: typeof Mail }> = {
  email: { label: "Email templates", icon: Mail },
  whatsapp: { label: "WhatsApp templates", icon: MessageCircle },
};

export function MessageTemplatesManager({ canManage }: { canManage: boolean }) {
  const [templates, setTemplates] = useState<MessageTemplateDTO[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ channel: MessageTemplateChannel; template: MessageTemplateDTO | null } | null>(null);
  const [deleting, setDeleting] = useState<MessageTemplateDTO | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTemplates(await api.get<MessageTemplateDTO[]>("/api/message-templates"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api.delete(`/api/message-templates/${deleting.id}`);
      setTemplates((prev) => prev?.filter((t) => t.id !== deleting.id) ?? null);
      setDeleting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete template");
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div>
      <div className="space-y-6 p-4 md:p-6">
        {loading && !templates ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <LayoutTemplate className="mr-2 h-5 w-5 animate-pulse" /> Loading…
          </div>
        ) : error ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            <p>{error}</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={load}>Retry</Button>
          </Card>
        ) : templates ? (
          (Object.keys(CHANNEL_META) as MessageTemplateChannel[]).map((channel) => (
            <ChannelSection
              key={channel}
              channel={channel}
              templates={templates.filter((t) => t.channel === channel)}
              canManage={canManage}
              onAdd={() => setEditing({ channel, template: null })}
              onEdit={(t) => setEditing({ channel, template: t })}
              onDelete={setDeleting}
            />
          ))
        ) : null}
      </div>

      {editing && (
        <TemplateFormDialog
          channel={editing.channel}
          template={editing.template}
          onClose={() => setEditing(null)}
          onSaved={(t) => {
            setTemplates((prev) => {
              if (!prev) return [t];
              const exists = prev.some((p) => p.id === t.id);
              return exists ? prev.map((p) => (p.id === t.id ? t : p)) : [...prev, t];
            });
            setEditing(null);
          }}
        />
      )}

      {deleting && (
        <Dialog open onClose={() => setDeleting(null)} title="Delete template?" className="md:max-w-sm">
          <div className="space-y-4 px-4 py-5 md:px-6">
            <p className="text-sm text-foreground">
              Delete <span className="font-medium">{deleting.name}</span>? Staff will no longer see it in the
              template picker. This can&apos;t be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeleting(null)} disabled={deleteBusy}>Cancel</Button>
              <Button variant="destructive" onClick={confirmDelete} disabled={deleteBusy}>
                {deleteBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                Delete
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function ChannelSection({
  channel,
  templates,
  canManage,
  onAdd,
  onEdit,
  onDelete,
}: {
  channel: MessageTemplateChannel;
  templates: MessageTemplateDTO[];
  canManage: boolean;
  onAdd: () => void;
  onEdit: (t: MessageTemplateDTO) => void;
  onDelete: (t: MessageTemplateDTO) => void;
}) {
  const meta = CHANNEL_META[channel];
  const Icon = meta.icon;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">{meta.label}</h3>
          <Badge className="bg-secondary text-secondary-foreground">{templates.length}</Badge>
        </div>
        {canManage && (
          <Button size="sm" variant="outline" onClick={onAdd} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Add template
          </Button>
        )}
      </div>

      {templates.length === 0 ? (
        <Card className="p-5 text-center text-sm text-muted-foreground">No {meta.label.toLowerCase()} yet.</Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <Card key={t.id} className="flex flex-col p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-foreground">{t.name}</p>
                {canManage && (
                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={() => onEdit(t)}
                      title="Edit"
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => onDelete(t)}
                      title="Delete"
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
              {t.subject && <p className="mt-1 text-xs font-medium text-muted-foreground">{t.subject}</p>}
              <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground">{t.body}</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateFormDialog({
  channel,
  template,
  onClose,
  onSaved,
}: {
  channel: MessageTemplateChannel;
  template: MessageTemplateDTO | null;
  onClose: () => void;
  onSaved: (t: MessageTemplateDTO) => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim() || !body.trim() || (channel === "email" && !subject.trim())) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        subject: channel === "email" ? subject.trim() : undefined,
        body,
      };
      const saved = template
        ? await api.patch<MessageTemplateDTO>(`/api/message-templates/${template.id}`, payload)
        : await api.post<MessageTemplateDTO>("/api/message-templates", { channel, ...payload });
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save template");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={template ? "Edit template" : "New template"} className="md:max-w-lg">
      <div className="space-y-4 px-4 py-5 md:px-6">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Follow-up — no response"
            disabled={saving}
          />
        </div>
        {channel === "email" && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Subject</label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Quick Follow-Up from Meridian Wellness"
              disabled={saving}
            />
          </div>
        )}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">Message</label>
          <Textarea
            rows={10}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write the template…"
            disabled={saving}
            className={cn("resize-none font-mono text-xs")}
          />
          <p className="text-[11px] text-muted-foreground">
            <code className="rounded bg-secondary px-1 py-0.5">{"{name}"}</code> = the lead&apos;s first name,{" "}
            <code className="rounded bg-secondary px-1 py-0.5">{"{rep_name}"}</code> /{" "}
            <code className="rounded bg-secondary px-1 py-0.5">{"{rep_phone}"}</code> = the sending staff
            member&apos;s own name/phone. All three are filled in automatically when a template is used.
          </p>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex items-center justify-between pt-1">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            onClick={save}
            disabled={saving || !name.trim() || !body.trim() || (channel === "email" && !subject.trim())}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {template ? "Save changes" : "Create template"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
