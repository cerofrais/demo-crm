"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Folder, LayoutTemplate, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { personalizeTemplate, type MessageTemplateDTO, type MessageTemplateChannel } from "@/lib/message-templates";
import { buildFolderTree, flattenTree, type FolderDTO } from "@/lib/template-folders";

interface MeProfile {
  displayName: string;
  phone: string | null;
}

/**
 * "Templates" button + popover list, shared by all four send surfaces
 * (individual WhatsApp/email, bulk WhatsApp/email). Fetches templates for
 * `channel` lazily on first open, plus the current staff member's own
 * name/phone — {rep_name}/{rep_phone} are resolved here, before the
 * template ever reaches the caller, since the sender is always known
 * immediately. {name} (the guest's name) is deliberately left untouched:
 * the caller resolves it however fits — immediately for an individual
 * composer (recipient already known), or left as a token for bulk sends
 * (resolved per-recipient server-side at send time).
 */
export function TemplatePicker({
  channel,
  onSelect,
  openUpward = false,
  align = "right",
}: {
  channel: MessageTemplateChannel;
  onSelect: (t: MessageTemplateDTO) => void;
  openUpward?: boolean;
  /** Which side of the button the popover's edge anchors to — "left" opens
   *  rightward (use when the button sits near the left of a wide row, e.g.
   *  a compose bar, so the popover doesn't run off the panel's left edge). */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<MessageTemplateDTO[] | null>(null);
  const [folders, setFolders] = useState<FolderDTO[]>([]);
  /** The folder being looked inside; null is the top of the channel. */
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [me, setMe] = useState<MeProfile | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  function openPicker() {
    // Every open starts at the top of the tree: picking up where someone left
    // off three messages ago is more confusing than one click back in.
    setCursor(null);
    setOpen((o) => !o);
    if (templates === null) {
      setLoading(true);
      Promise.all([
        api.get<MessageTemplateDTO[]>(`/api/message-templates?channel=${channel}`),
        api.get<MeProfile>("/api/staff-profiles/me").catch(() => null),
        api.get<FolderDTO[]>(`/api/message-templates/folders?channel=${channel}`).catch(() => []),
      ])
        .then(([tpls, meProfile, fldrs]) => {
          setTemplates(tpls);
          setMe(meProfile);
          setFolders(fldrs);
        })
        .catch(() => setTemplates([]))
        .finally(() => setLoading(false));
    }
  }

  function pick(t: MessageTemplateDTO) {
    const vars = { repName: me?.displayName, repPhone: me?.phone ?? undefined };
    onSelect({
      ...t,
      subject: t.subject ? personalizeTemplate(t.subject, vars) : t.subject,
      body: personalizeTemplate(t.body, vars),
    });
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <Button type="button" variant="outline" size="icon" onClick={openPicker} title="Insert a template">
        <LayoutTemplate className="h-4 w-4" />
      </Button>

      {open && (
        <div
          className={cn(
            "absolute z-20 w-64 rounded-md border border-border bg-popover shadow-lg",
            align === "left" ? "left-0" : "right-0",
            openUpward ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          <div className="max-h-72 overflow-y-auto py-1">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            )}
            {!loading && templates?.length === 0 && (
              <p className="px-3 py-3 text-sm text-muted-foreground">No templates yet.</p>
            )}
            {/* Folders first, then what is in the one you opened — the same
                shape as the Templates page, so a rep looking for a template
                walks the same path the person who filed it took. */}
            {!loading && templates && (
              <TemplateBrowser
                templates={templates}
                folders={folders}
                cursor={cursor}
                onOpenFolder={setCursor}
                onPick={pick}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One level of the folder tree: the folders inside the current one, then the
 * templates filed directly in it.
 *
 * Counts come from the templates actually in hand, not from the folder rows'
 * own counts, so an archived template — which this list never offers — cannot
 * inflate a number and send someone into an empty folder.
 */
function TemplateBrowser({
  templates,
  folders,
  cursor,
  onOpenFolder,
  onPick,
}: {
  templates: MessageTemplateDTO[];
  folders: FolderDTO[];
  cursor: string | null;
  onOpenFolder: (id: string | null) => void;
  onPick: (t: MessageTemplateDTO) => void;
}) {
  const counted = folders.map((f) => ({
    ...f,
    templateCount: templates.filter((t) => t.folderId === f.id).length,
  }));
  const tree = buildFolderTree(counted);
  const nodes = flattenTree(tree);

  const current = cursor ? nodes.find((n) => n.id === cursor) ?? null : null;
  const children = nodes.filter((n) => n.parentId === cursor);
  const here = templates.filter((t) => (t.folderId ?? null) === cursor);

  if (!templates.length) return <p className="px-3 py-3 text-sm text-muted-foreground">No templates yet.</p>;

  return (
    <>
      {current && (
        <button
          type="button"
          onClick={() => onOpenFolder(current.parentId)}
          className="flex w-full items-center gap-1.5 border-b border-border px-2.5 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary"
        >
          <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{current.path}</span>
        </button>
      )}

      {children.map((node) => (
        <button
          key={node.id}
          type="button"
          onClick={() => onOpenFolder(node.id)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-secondary"
        >
          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{node.totalCount}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      ))}

      {here.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onPick(t)}
          className="block w-full truncate px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-secondary"
        >
          {t.name}
        </button>
      ))}

      {!children.length && !here.length && (
        <p className="px-3 py-3 text-sm text-muted-foreground">This folder is empty.</p>
      )}
    </>
  );
}
