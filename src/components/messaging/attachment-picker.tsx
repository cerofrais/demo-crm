"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Paperclip, Loader2, Upload, Search, FileText, Users } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";

export interface AttachableDoc {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  guestId: string | null;
  createdAt: string;
}

/**
 * What the composer got back. An `existing` selection is already a Document,
 * so the send path skips the upload entirely; a `new` one is uploaded at send
 * time exactly as before.
 */
export type AttachmentSelection =
  | { kind: "existing"; doc: AttachableDoc }
  | { kind: "new"; file: File };

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Five rows plus a sliver of the sixth, so it reads as scrollable. */
const LIST_MAX_HEIGHT = "15.5rem";
/** Wide enough for a long library filename beside its size column. */
const WIDTH_PX = 340;
/** Never let the panel touch a screen edge. */
const GUTTER = 8;
/** Below this there isn't room for the search box plus a usable list. */
const MIN_SPACE = 220;
/** Whole panel: search box, list, and the upload row beneath it. */
const PANEL_MAX_PX = 420;

/**
 * Paperclip button + popover for picking a message attachment.
 *
 * Lists the shared Resources library alongside this guest's own documents
 * (scope=attachable mirrors the send routes' findAttachableDocument, so the
 * picker can never offer something the send would then refuse), with an
 * "Upload new file" escape hatch.
 *
 * Picking a file to upload first checks whether that exact file is already
 * here — same filename, size and type — and selects the existing document
 * instead of uploading a second copy. That check is server-side, so it still
 * finds a match in a library longer than the list's 200-row page.
 */
export function AttachmentPicker({
  guestId,
  disabled = false,
  openUpward = false,
  align = "left",
  accept,
  title = "Attach a file",
  onSelect,
}: {
  /** Omit for a broadcast composer — then only library files are offered. */
  guestId?: string;
  disabled?: boolean;
  openUpward?: boolean;
  align?: "left" | "right";
  accept?: string;
  title?: string;
  onSelect: (selection: AttachmentSelection, note?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<AttachableDoc[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [checking, setChecking] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  /**
   * The popover is rendered in a PORTAL, positioned against the trigger's
   * viewport rect.
   *
   * It used to be an absolutely-positioned child, which meant any ancestor
   * with `overflow` clipped it — and every place this is used sits inside
   * one: a dialog's scroll box, a chat pane, a table cell. The symptom was
   * a popover with its left edge (and the start of every filename) shaved
   * off, or its list cut in half at the dialog's bottom border. No amount of
   * widening the dialog or flipping the anchor side fixes that; escaping the
   * clipping context does.
   */
  useEffect(() => {
    if (!open) return;
    function place() {
      const trigger = rootRef.current?.getBoundingClientRect();
      if (!trigger) return;
      const width = Math.min(WIDTH_PX, window.innerWidth - GUTTER * 2);
      const wantLeft = align === "right" ? trigger.right - width : trigger.left;
      // Clamped so it can never hang off either edge of the screen — which is
      // what a phone-width viewport would otherwise do.
      const left = Math.min(Math.max(GUTTER, wantLeft), window.innerWidth - width - GUTTER);

      const below = window.innerHeight - trigger.bottom - GUTTER;
      const above = trigger.top - GUTTER;
      // Flip up only when below genuinely can't hold it AND above is roomier,
      // so the list isn't squeezed into a sliver for no reason.
      const flipUp = openUpward || (below < MIN_SPACE && above > below);
      const maxHeight = Math.max(MIN_SPACE, flipUp ? above : below);
      setPos({
        top: flipUp ? Math.max(GUTTER, trigger.top - Math.min(maxHeight, PANEL_MAX_PX) - 6) : trigger.bottom + 6,
        left,
        maxHeight: Math.min(maxHeight, PANEL_MAX_PX),
      });
    }
    place();
    // `true` captures scrolls inside any container, not just the window —
    // the trigger usually lives in one.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, align, openUpward]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      const t = e.target as Node;
      // The popover is no longer a DOM child of the trigger, so it has to be
      // checked separately or clicking inside it would close it.
      if (rootRef.current?.contains(t) || popoverRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ scope: "attachable" });
    if (guestId) params.set("guestId", guestId);
    api
      .get<AttachableDoc[]>(`/api/files?${params}`)
      .then(setDocs)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load files"))
      .finally(() => setLoading(false));
  }, [guestId]);

  function toggle() {
    setOpen((o) => !o);
    if (docs === null) load();
  }

  /**
   * A picked file is only uploaded if it isn't already here. Filename + size
   * + type is what the browser knows without reading the bytes, so the check
   * costs one request and no upload.
   */
  async function handleFile(file: File) {
    const mimeType = file.type || "application/octet-stream";
    setChecking(true);
    try {
      const params = new URLSearchParams({
        scope: "attachable",
        filename: file.name,
        sizeBytes: String(file.size),
        mimeType,
      });
      if (guestId) params.set("guestId", guestId);
      const matches = await api.get<AttachableDoc[]>(`/api/files?${params}`);
      if (matches.length) {
        onSelect(
          { kind: "existing", doc: matches[0] },
          `"${file.name}" is already here — using the existing copy instead of uploading it again.`,
        );
        setOpen(false);
        return;
      }
      onSelect({ kind: "new", file });
      setOpen(false);
    } catch {
      // A failed lookup must not block sending — fall back to uploading,
      // which is exactly the old behaviour.
      onSelect({ kind: "new", file });
      setOpen(false);
    } finally {
      setChecking(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const needle = q.trim().toLowerCase();
  const visible = (docs ?? []).filter((d) => !needle || d.filename.toLowerCase().includes(needle));

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        accept={accept}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={toggle}
        disabled={disabled}
        title={title}
      >
        {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
      </Button>

      {open && pos && createPortal(
        <div
          ref={popoverRef}
          style={{
            top: pos.top,
            left: pos.left,
            width: Math.min(WIDTH_PX, typeof window === "undefined" ? WIDTH_PX : window.innerWidth - GUTTER * 2),
            maxHeight: pos.maxHeight,
          }}
          // z-index clears the dialog overlay this often opens on top of.
          className="fixed z-[100] flex flex-col overflow-hidden rounded-md border border-border bg-popover shadow-lg"
        >
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search Resources…"
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto" style={{ maxHeight: LIST_MAX_HEIGHT }}>
            {loading && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            )}
            {!loading && error && (
              <p className="px-3 py-3 text-xs text-destructive">{error}</p>
            )}
            {!loading && !error && visible.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                {needle ? "No file matches that." : "No files in Resources yet."}
              </p>
            )}
            {!loading &&
              !error &&
              visible.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => {
                    onSelect({ kind: "existing", doc: d });
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-secondary"
                >
                  {/* A guest-scoped file is one already sent to or received
                      from this guest — worth distinguishing from the shared
                      library so a rep knows what they're re-sending. */}
                  {d.guestId ? (
                    <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  {/* Long library names ("Rakshabandhan Voucher …") clip in a
                      popover this narrow — the tooltip is what makes two
                      similarly-named files tellable apart. */}
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={d.filename}>
                    {d.filename}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {humanSize(d.sizeBytes)}
                  </span>
                </button>
              ))}
          </div>

          <div className="border-t border-border p-1">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={checking}
              className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
            >
              {checking ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              {checking ? "Checking…" : "Upload new file…"}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
