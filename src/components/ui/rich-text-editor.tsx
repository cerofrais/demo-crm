"use client";

import { useEffect, useRef } from "react";
import { Bold, Italic, Underline, Link2, Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface RichTextEditorProps {
  html: string;
  onChange: (html: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Called when the toolbar's image button picks a file — the caller
   *  handles the actual upload (same upload-url/confirm flow used for
   *  attachments) and returns the resulting Document id, which the editor
   *  inserts as `<img src="cid:{id}">` so the send-time server code can
   *  find and embed it. Image button is hidden if this isn't passed. */
  onUploadImage?: (file: File) => Promise<string | null>;
}

/**
 * Minimal WYSIWYG for email compose — bold/italic/underline, a link, and an
 * inline image, nothing more. Built on contentEditable + execCommand rather
 * than pulling in a WYSIWYG dependency: this codebase has none installed,
 * and the only asks are five formatting actions, not a document editor.
 * Images are referenced as `cid:{documentId}` (not a data: URL or a signed
 * link) — see src/lib/mail-html.ts, which resolves those into real inline
 * MIME attachments at send time, the same way a desktop mail client embeds
 * a pasted image.
 */
export function RichTextEditor({
  html,
  onChange,
  placeholder,
  disabled,
  className,
  onUploadImage,
}: RichTextEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // null sentinel (rather than initializing to `html`) so the first effect
  // run always syncs the DOM — needed for a caller that mounts this with
  // non-empty initial content, e.g. opening an editor pre-filled from a draft.
  const lastHtmlRef = useRef<string | null>(null);

  // Only push `html` into the DOM when it changed from OUTSIDE this
  // component (e.g. a template was picked) — otherwise every keystroke's
  // own onChange would round-trip back in and reset the caret position.
  useEffect(() => {
    if (html !== lastHtmlRef.current && ref.current && ref.current.innerHTML !== html) {
      ref.current.innerHTML = html;
      lastHtmlRef.current = html;
    }
  }, [html]);

  function emitChange() {
    const next = ref.current?.innerHTML ?? "";
    lastHtmlRef.current = next;
    onChange(next);
  }

  function exec(command: string, value?: string) {
    ref.current?.focus();
    document.execCommand(command, false, value);
    emitChange();
  }

  function insertLink() {
    const url = window.prompt("Link URL (e.g. https://example.com)");
    if (!url) return;
    exec("createLink", url);
  }

  async function pickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file || !onUploadImage) return;
    const docId = await onUploadImage(file);
    if (!docId) return;
    ref.current?.focus();
    document.execCommand(
      "insertHTML",
      false,
      `<img src="cid:${docId}" alt="${file.name.replace(/"/g, "")}" style="max-width:100%" />`,
    );
    emitChange();
  }

  const isEmpty = !html || html === "<br>";

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-input bg-background shadow-sm", className)}>
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border bg-secondary/40 p-1">
        <ToolbarButton title="Bold" onClick={() => exec("bold")} disabled={disabled}>
          <Bold className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Italic" onClick={() => exec("italic")} disabled={disabled}>
          <Italic className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Underline" onClick={() => exec("underline")} disabled={disabled}>
          <Underline className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Insert link" onClick={insertLink} disabled={disabled}>
          <Link2 className="h-3.5 w-3.5" />
        </ToolbarButton>
        {onUploadImage && (
          <>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={pickImage} />
            <ToolbarButton title="Insert image" onClick={() => fileRef.current?.click()} disabled={disabled}>
              <ImageIcon className="h-3.5 w-3.5" />
            </ToolbarButton>
          </>
        )}
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {isEmpty && placeholder && (
          <p className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">{placeholder}</p>
        )}
        <div
          ref={ref}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={emitChange}
          onBlur={emitChange}
          className="min-h-[80px] px-3 py-2 text-sm outline-none [&_a]:text-brand-600 [&_a]:underline [&_img]:max-w-full"
        />
      </div>
    </div>
  );
}

function ToolbarButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      // mousedown (not click) + preventDefault keeps the contentEditable
      // selection intact — a click would blur the editor and drop it first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  );
}
