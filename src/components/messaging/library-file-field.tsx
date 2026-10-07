"use client";

import { useState } from "react";
import { Loader2, Paperclip, X } from "lucide-react";
import { AttachmentPicker, type AttachmentSelection } from "@/components/messaging/attachment-picker";
import { api } from "@/lib/client";

export interface LibraryFile {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Pick (or clear) a shared library file — an auto-reply's attachment, a
 * broadcast template's header image. Library
 * documents only — one asset is sent to every guest the rule fires for, so a
 * guest-scoped file is never the right thing here (the server enforces the
 * same rule via findBroadcastableDocument). A newly-picked file is uploaded
 * to the shared library under "marketing" before its id is handed back.
 */
export function LibraryFileField({
  attachment,
  disabled,
  onChange,
}: {
  attachment: LibraryFile | null;
  disabled?: boolean;
  onChange: (documentId: string | null, file: LibraryFile | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSelect(sel: AttachmentSelection) {
    setError(null);
    if (sel.kind === "existing") {
      onChange(sel.doc.id, {
        id: sel.doc.id,
        filename: sel.doc.filename,
        mimeType: sel.doc.mimeType,
        sizeBytes: sel.doc.sizeBytes,
      });
      return;
    }
    setBusy(true);
    try {
      const file = sel.file;
      const mimeType = file.type || "application/octet-stream";
      const { url, storageKey } = await api.post<{ url: string; storageKey: string }>(
        "/api/files/upload-url",
        { filename: file.name, mimeType, category: "marketing", sizeBytes: file.size },
      );
      const put = await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": mimeType } });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      const doc = await api.post<{ id: string }>("/api/files/confirm", {
        storageKey, filename: file.name, mimeType, category: "marketing", sizeBytes: file.size,
      });
      onChange(doc.id, { id: doc.id, filename: file.name, mimeType, sizeBytes: file.size });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Paperclip className="h-3.5 w-3.5 shrink-0" />
        {attachment ? (
          <>
            <span
              className="min-w-0 max-w-full break-all font-medium text-foreground"
              title={attachment.filename}
            >
              {attachment.filename}
            </span>
            {!disabled && (
              <button
                type="button"
                onClick={() => onChange(null, null)}
                title="Remove attachment"
                className="rounded p-0.5 hover:bg-secondary hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </>
        ) : (
          <span>No file attached.</span>
        )}
        {!disabled && (
          <AttachmentPicker
            title={attachment ? "Replace file" : "Attach a file"}
            onSelect={handleSelect}
            disabled={busy}
            // Anchored right: the trigger sits mid-row inside a dialog, so a
            // left-aligned popover ran off the edge and forced the whole
            // dialog to scroll sideways.
            align="right"
          />
        )}
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
