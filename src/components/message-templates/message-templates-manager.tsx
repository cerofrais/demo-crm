"use client";

import { useCallback, useEffect, useState } from "react";
import { LayoutTemplate, Mail, MessageCircle, Plus, Pencil, Trash2, Loader2, Archive, ArchiveRestore, Folder, FolderPlus, FolderOpen, ChevronRight } from "lucide-react";
import { Card, Badge, Button, Input, Textarea, Dialog, RichTextEditor } from "@/components/ui";
import { uploadLibraryImage } from "@/components/messaging/upload-library-image";
import { templateBodyToHtml, templateBodyPreview } from "@/lib/message-templates";
import { buildFolderTree, flattenTree, FOLDER_NAME_MAX, type FolderDTO, type FolderNode } from "@/lib/template-folders";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { MessageTemplateDTO, MessageTemplateChannel } from "@/lib/message-templates";
import { EmailFooterSection } from "./email-footer-section";

const CHANNEL_META: Record<MessageTemplateChannel, { label: string; icon: typeof Mail }> = {
  email: { label: "Email templates", icon: Mail },
  whatsapp: { label: "WhatsApp templates", icon: MessageCircle },
};

export function MessageTemplatesManager({ canManage }: { canManage: boolean }) {
  const [templates, setTemplates] = useState<MessageTemplateDTO[] | null>(null);
  const [folders, setFolders] = useState<FolderDTO[]>([]);
  /** The highlighted folder per channel — what "New folder" nests inside and
   *  what "Add template" files into. Null means the channel's whole tree. */
  const [selected, setSelected] = useState<Partial<Record<MessageTemplateChannel, string | null>>>({});
  const [folderForm, setFolderForm] = useState<
    { channel: MessageTemplateChannel; parentId: string | null; folder: FolderDTO | null } | null
  >(null);
  const [folderDeleting, setFolderDeleting] = useState<FolderDTO | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ channel: MessageTemplateChannel; template: MessageTemplateDTO | null } | null>(null);
  const [deleting, setDeleting] = useState<MessageTemplateDTO | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // Off by default: archived templates are the ones staff should stop seeing.
  const [showArchived, setShowArchived] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, f] = await Promise.all([
        api.get<MessageTemplateDTO[]>("/api/message-templates?includeArchived=1"),
        api.get<FolderDTO[]>("/api/message-templates/folders"),
      ]);
      setTemplates(t);
      setFolders(f);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggleArchived(t: MessageTemplateDTO) {
    setArchivingId(t.id);
    setError(null);
    try {
      const saved = await api.patch<MessageTemplateDTO>(`/api/message-templates/${t.id}`, {
        archived: !t.archivedAt,
      });
      setTemplates((prev) => prev?.map((p) => (p.id === saved.id ? saved : p)) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update template");
    } finally {
      setArchivingId(null);
    }
  }

  const archivedCount = templates?.filter((t) => t.archivedAt).length ?? 0;

  /** Deleting a folder moves its contents; the templates all change folder,
   *  so both lists are re-read rather than patched in place. */
  async function confirmFolderDelete() {
    if (!folderDeleting) return;
    setFolderBusy(true);
    setError(null);
    try {
      await api.delete(`/api/message-templates/folders/${folderDeleting.id}`);
      setSelected((prev) => ({ ...prev, [folderDeleting.channel]: null }));
      setFolderDeleting(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete folder");
    } finally {
      setFolderBusy(false);
    }
  }

  async function moveTemplate(t: MessageTemplateDTO, folderId: string) {
    setError(null);
    try {
      const saved = await api.patch<MessageTemplateDTO>(`/api/message-templates/${t.id}`, { folderId });
      setTemplates((prev) => prev?.map((p) => (p.id === saved.id ? saved : p)) ?? null);
      setFolders(await api.get<FolderDTO[]>("/api/message-templates/folders"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move template");
    }
  }

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
          <>
            <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-input accent-brand-600"
              />
              Show archived templates{archivedCount ? ` (${archivedCount})` : ""}
            </label>
            {(Object.keys(CHANNEL_META) as MessageTemplateChannel[]).map((channel) => {
              const inChannel = templates.filter((t) => t.channel === channel);
              return (
                <ChannelSection
                  key={channel}
                  channel={channel}
                  templates={inChannel.filter((t) => showArchived || !t.archivedAt)}
                  activeCount={inChannel.filter((t) => !t.archivedAt).length}
                  folders={folders.filter((f) => f.channel === channel)}
                  selectedId={selected[channel] ?? null}
                  onSelectFolder={(id) => setSelected((prev) => ({ ...prev, [channel]: id }))}
                  canManage={canManage}
                  archivingId={archivingId}
                  onAdd={() => setEditing({ channel, template: null })}
                  onEdit={(t) => setEditing({ channel, template: t })}
                  onToggleArchived={toggleArchived}
                  onDelete={setDeleting}
                  onNewFolder={() => setFolderForm({ channel, parentId: selected[channel] ?? null, folder: null })}
                  onRenameFolder={(f) => setFolderForm({ channel, parentId: f.parentId, folder: f })}
                  onDeleteFolder={setFolderDeleting}
                  onMoveTemplate={moveTemplate}
                />
              );
            })}
          </>
        ) : null}

        {/* The footer belongs here rather than on Auto-Reply: it is content
            appended to what staff write, not a rule that fires on its own.
            Email auto-replies live on the Auto-Reply page beside the
            WhatsApp ones, so every automatic reply is in one place. */}
        <EmailFooterSection canManage={canManage} />
      </div>

      {editing && (
        <TemplateFormDialog
          channel={editing.channel}
          template={editing.template}
          folders={folders.filter((f) => f.channel === editing.channel)}
          defaultFolderId={selected[editing.channel] ?? null}
          onClose={() => setEditing(null)}
          onSaved={(t) => {
            setTemplates((prev) => {
              if (!prev) return [t];
              const exists = prev.some((p) => p.id === t.id);
              return exists ? prev.map((p) => (p.id === t.id ? t : p)) : [...prev, t];
            });
            setEditing(null);
            void api.get<FolderDTO[]>("/api/message-templates/folders").then(setFolders).catch(() => {});
          }}
        />
      )}

      {folderForm && (
        <FolderFormDialog
          channel={folderForm.channel}
          parentId={folderForm.parentId}
          folder={folderForm.folder}
          parentName={
            folderForm.parentId
              ? (folders.find((f) => f.id === folderForm.parentId)?.name ?? null)
              : null
          }
          onClose={() => setFolderForm(null)}
          onSaved={(f) => {
            setFolders((prev) => {
              const exists = prev.some((p) => p.id === f.id);
              return exists ? prev.map((p) => (p.id === f.id ? f : p)) : [...prev, f];
            });
            setSelected((prev) => ({ ...prev, [f.channel]: f.id }));
            setFolderForm(null);
          }}
        />
      )}

      {folderDeleting && (
        <Dialog open onClose={() => setFolderDeleting(null)} title="Delete folder?" className="md:max-w-sm">
          <div className="space-y-4 px-4 py-5 md:px-6">
            <p className="text-sm text-foreground">
              Delete <span className="font-medium">{folderDeleting.name}</span>? Nothing inside it is lost — its
              templates and any folders within it move
              {folderDeleting.parentId ? " up one level" : ' to "Others"'}.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setFolderDeleting(null)} disabled={folderBusy}>Cancel</Button>
              <Button variant="destructive" onClick={confirmFolderDelete} disabled={folderBusy}>
                {folderBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                Delete folder
              </Button>
            </div>
          </div>
        </Dialog>
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
  activeCount,
  folders,
  selectedId,
  onSelectFolder,
  canManage,
  archivingId,
  onAdd,
  onEdit,
  onToggleArchived,
  onDelete,
  onNewFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveTemplate,
}: {
  channel: MessageTemplateChannel;
  templates: MessageTemplateDTO[];
  /** Counted separately so the badge means "in use", whether or not archived
   *  templates are being shown below it. */
  activeCount: number;
  folders: FolderDTO[];
  selectedId: string | null;
  onSelectFolder: (id: string | null) => void;
  canManage: boolean;
  archivingId: string | null;
  onAdd: () => void;
  onEdit: (t: MessageTemplateDTO) => void;
  onToggleArchived: (t: MessageTemplateDTO) => void;
  onDelete: (t: MessageTemplateDTO) => void;
  onNewFolder: () => void;
  onRenameFolder: (f: FolderDTO) => void;
  onDeleteFolder: (f: FolderDTO) => void;
  onMoveTemplate: (t: MessageTemplateDTO, folderId: string) => void;
}) {
  const meta = CHANNEL_META[channel];
  const Icon = meta.icon;
  const tree = buildFolderTree(folders);
  const flat = flattenTree(tree);
  const selected = selectedId ? folders.find((f) => f.id === selectedId) ?? null : null;
  // With a folder highlighted the list is that folder's own templates;
  // with none, the whole channel, so nothing is ever hidden by accident.
  const shown = selectedId ? templates.filter((t) => t.folderId === selectedId) : templates;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">{meta.label}</h3>
          <Badge className="bg-secondary text-secondary-foreground">{activeCount}</Badge>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onNewFolder} className="gap-1.5">
              <FolderPlus className="h-3.5 w-3.5" />
              {selected ? `New folder in ${selected.name}` : "New folder"}
            </Button>
            <Button size="sm" variant="outline" onClick={onAdd} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              {selected ? `Add template to ${selected.name}` : "Add template"}
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
        {/* The folders. Clicking one highlights it, and the two buttons above
            then act inside it — a new folder goes in it, a new template goes
            in it. */}
        <Card className="h-fit p-2">
          <button
            type="button"
            onClick={() => onSelectFolder(null)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              selectedId === null ? "bg-brand-100 font-medium text-brand-800" : "hover:bg-secondary",
            )}
          >
            <LayoutTemplate className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">All templates</span>
            <span className="ml-auto text-xs text-muted-foreground">{templates.length}</span>
          </button>

          {flat.map((node) => (
            <FolderRow
              key={node.id}
              node={node}
              selected={node.id === selectedId}
              canManage={canManage}
              onSelect={() => onSelectFolder(node.id)}
              onRename={() => onRenameFolder(node)}
              onDelete={() => onDeleteFolder(node)}
            />
          ))}

          {!flat.length && (
            <p className="px-2 py-3 text-xs text-muted-foreground">No folders yet.</p>
          )}
        </Card>

        <div>
          {shown.length === 0 ? (
            <Card className="p-5 text-center text-sm text-muted-foreground">
              {selected ? `Nothing in ${selected.name} yet.` : `No ${meta.label.toLowerCase()} yet.`}
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((t) => (
                <Card key={t.id} className={cn("flex flex-col p-4", t.archivedAt && "bg-muted/40 opacity-70")}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">{t.name}</p>
                      {/* Where it lives, so the card still says so when the
                          whole channel is being shown at once. */}
                      {t.folderPath && (
                        <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Folder className="h-3 w-3 shrink-0" />
                          <span className="truncate">{t.folderPath}</span>
                        </p>
                      )}
                      {t.archivedAt && (
                        <Badge className="mt-1 bg-secondary text-[10px] text-muted-foreground">Archived</Badge>
                      )}
                    </div>
                    {canManage && (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          onClick={() => onEdit(t)}
                          title="Edit"
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => onToggleArchived(t)}
                          title={t.archivedAt ? "Restore" : "Archive"}
                          disabled={archivingId === t.id}
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
                        >
                          {archivingId === t.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : t.archivedAt ? (
                            <ArchiveRestore className="h-3.5 w-3.5" />
                          ) : (
                            <Archive className="h-3.5 w-3.5" />
                          )}
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
                  <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground">{templateBodyPreview(t.body)}</p>

                  {canManage && flat.length > 0 && (
                    <label className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="shrink-0">Folder</span>
                      <select
                        value={t.folderId ?? ""}
                        onChange={(e) => e.target.value && onMoveTemplate(t, e.target.value)}
                        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-xs"
                      >
                        {!t.folderId && <option value="">No folder</option>}
                        {flat.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.path}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One folder in the tree: indented by depth, with its own count and actions. */
function FolderRow({
  node,
  selected,
  canManage,
  onSelect,
  onRename,
  onDelete,
}: {
  node: FolderNode;
  selected: boolean;
  canManage: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center rounded-md transition-colors",
        selected ? "bg-brand-100" : "hover:bg-secondary",
      )}
      style={{ paddingLeft: `${node.depth * 0.75}rem` }}
    >
      <button
        type="button"
        onClick={onSelect}
        className={cn("flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-sm", selected && "font-medium text-brand-800")}
      >
        {node.depth > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
        {selected ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-brand-600" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{node.name}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{node.totalCount}</span>
      </button>
      {canManage && (
        <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button onClick={onRename} title="Rename folder" className="rounded-md p-1 text-muted-foreground hover:text-foreground">
            <Pencil className="h-3 w-3" />
          </button>
          <button onClick={onDelete} title="Delete folder" className="rounded-md p-1 pr-1.5 text-muted-foreground hover:text-destructive">
            <Trash2 className="h-3 w-3" />
          </button>
        </span>
      )}
    </div>
  );
}

/** Make a folder, or rename one. Where it sits is decided by what was
 *  highlighted when the button was pressed, which the title spells out. */
function FolderFormDialog({
  channel,
  parentId,
  parentName,
  folder,
  onClose,
  onSaved,
}: {
  channel: MessageTemplateChannel;
  parentId: string | null;
  parentName: string | null;
  folder: FolderDTO | null;
  onClose: () => void;
  onSaved: (f: FolderDTO) => void;
}) {
  const [name, setName] = useState(folder?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = folder
        ? await api.patch<FolderDTO>(`/api/message-templates/folders/${folder.id}`, { name: name.trim() })
        : await api.post<FolderDTO>("/api/message-templates/folders", { channel, name: name.trim(), parentId });
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save folder");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={folder ? "Rename folder" : parentName ? `New folder in ${parentName}` : "New folder"}
      className="md:max-w-sm"
    >
      <div className="space-y-4 px-4 py-5 md:px-6">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={FOLDER_NAME_MAX}
            placeholder="e.g. Detox"
            autoFocus
            disabled={saving}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
        </div>
        {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || !name.trim()}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {folder ? "Rename" : "Create folder"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function TemplateFormDialog({
  channel,
  template,
  folders,
  defaultFolderId,
  onClose,
  onSaved,
}: {
  channel: MessageTemplateChannel;
  template: MessageTemplateDTO | null;
  folders: FolderDTO[];
  /** The folder highlighted on the page — where a new template lands unless
   *  it is changed here. */
  defaultFolderId: string | null;
  onClose: () => void;
  onSaved: (t: MessageTemplateDTO) => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  // A template written before the rich editor is plain text, where the
  // newlines carry the formatting. Loading it into a contentEditable raw
  // would collapse every one of them into a space — and then SAVE that,
  // silently flattening the template. Converted on the way in instead.
  const [body, setBody] = useState(
    channel === "email" ? templateBodyToHtml(template?.body ?? "") : (template?.body ?? ""),
  );
  const [folderId, setFolderId] = useState(template?.folderId ?? defaultFolderId ?? "");
  const folderOptions = flattenTree(buildFolderTree(folders));
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
        // Empty means "no folder chosen"; the server files it under the
        // channel's "Others" rather than leaving it outside the tree.
        folderId: folderId || undefined,
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
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">Folder</label>
          <select
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            disabled={saving}
            className="flex h-11 w-full rounded-md border border-input bg-background px-3 text-base shadow-sm lg:h-9 lg:text-sm"
          >
            <option value="">Others</option>
            {folderOptions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.path}
              </option>
            ))}
          </select>
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
          {/* Email templates are rich: the compose box they are inserted into
              already renders HTML and already embeds cid: images at send
              time, so the only thing missing was an editor that could
              produce them. WhatsApp has no HTML, so it stays plain. */}
          {channel === "email" ? (
            <RichTextEditor
              html={body}
              onChange={setBody}
              disabled={saving}
              onUploadImage={uploadLibraryImage}
              placeholder="Write the template…"
            />
          ) : (
            <Textarea
              rows={10}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write the template…"
              disabled={saving}
              className={cn("resize-none font-mono text-xs")}
            />
          )}
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
