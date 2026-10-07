"use client";

import { useEffect, useRef, useState } from "react";
import { Bold, Italic, Underline, Link2, Image as ImageIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { dataUrlToFile, EMBEDDABLE_IMAGE, safeImageName } from "@/lib/data-url-file";
import { cidToPreview, previewToCid } from "@/lib/editor-cid-preview";

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
 *
 * PASTE AND DROP ARE HANDLED, NOT LEFT TO THE BROWSER. Pasting a signature
 * copied from Gmail or a website inserts the clipboard's HTML verbatim, and
 * the logo in it arrives as a `data:image/…;base64` blob — tens of thousands
 * of characters for one small image. That blew straight past the footer's
 * size limit, and even under the limit the server's sanitizer drops data:
 * images, so the logo would have vanished on save without a word. Every
 * pasted image is now uploaded like one picked with the image button and
 * rewritten to `cid:`, so it is embedded properly or not inserted at all.
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
  const [uploading, setUploading] = useState(false);
  // null sentinel (rather than initializing to `html`) so the first effect
  // run always syncs the DOM — needed for a caller that mounts this with
  // non-empty initial content, e.g. opening an editor pre-filled from a draft.
  const lastHtmlRef = useRef<string | null>(null);

  // Only push `html` into the DOM when it changed from OUTSIDE this
  // component (e.g. a template was picked) — otherwise every keystroke's
  // own onChange would round-trip back in and reset the caret position.
  useEffect(() => {
    if (html !== lastHtmlRef.current && ref.current && previewToCid(ref.current.innerHTML) !== html) {
      // cid: images cannot load in a browser, so they are displayed through
      // the file route and converted back in emitChange — see
      // lib/editor-cid-preview.ts. What the caller stores never changes.
      ref.current.innerHTML = cidToPreview(html);
      lastHtmlRef.current = html;
    }
  }, [html]);

  function emitChange() {
    const next = previewToCid(ref.current?.innerHTML ?? "");
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

  /** Remember where the caret was, so HTML inserted after an async upload
   *  lands where the author pasted rather than wherever focus drifted. */
  function saveSelection(): Range | null {
    const sel = window.getSelection();
    if (!sel?.rangeCount || !ref.current?.contains(sel.anchorNode)) return null;
    return sel.getRangeAt(0).cloneRange();
  }

  function insertHtmlAt(range: Range | null, markup: string) {
    ref.current?.focus();
    if (range) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    document.execCommand("insertHTML", false, markup);
    emitChange();
  }

  async function uploadAsCid(file: File): Promise<string | null> {
    if (!onUploadImage || !EMBEDDABLE_IMAGE.test(file.type)) return null;
    const id = await onUploadImage(file);
    return id ? `cid:${id}` : null;
  }

  async function pickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    const range = saveSelection();
    setUploading(true);
    try {
      const src = await uploadAsCid(file);
      if (src) insertHtmlAt(range, imgTag(src, file.name));
    } finally {
      setUploading(false);
    }
  }

  /**
   * Rewrite every <img> in pasted HTML so it can survive being emailed:
   *   • data: images are uploaded and become cid: — the case that broke the
   *     footer;
   *   • remote http(s) images are fetched and embedded the same way when the
   *     host allows it, and otherwise left as a link (the sanitizer permits
   *     https, most clients just hide it until the reader allows images);
   *   • anything else — blob:, file: — points at the author's own machine and
   *     can never reach a recipient, so it is dropped.
   */
  async function embedPastedImages(markup: string): Promise<string> {
    const doc = new DOMParser().parseFromString(markup, "text/html");
    for (const img of Array.from(doc.querySelectorAll("img"))) {
      const src = img.getAttribute("src") ?? "";
      const alt = img.getAttribute("alt") ?? "image";
      let next: string | null = null;
      if (src.startsWith("cid:")) continue;
      if (src.startsWith("data:")) {
        const file = dataUrlToFile(src, alt);
        next = file ? await uploadAsCid(file) : null;
      } else if (/^https?:\/\//i.test(src)) {
        next = await fetchAndEmbed(src, alt).catch(() => null);
        if (!next) continue; // keep the remote link rather than lose the image
      }
      if (next) {
        img.setAttribute("src", next);
        img.setAttribute("style", "max-width:100%");
        img.removeAttribute("srcset");
      } else {
        img.remove();
      }
    }
    return cidToPreview(doc.body.innerHTML);
  }

  async function fetchAndEmbed(url: string, alt: string): Promise<string | null> {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!EMBEDDABLE_IMAGE.test(blob.type)) return null;
    const ext = blob.type.split("/")[1].replace("jpeg", "jpg");
    return uploadAsCid(new File([blob], `${safeImageName(alt)}.${ext}`, { type: blob.type }));
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const markup = e.clipboardData.getData("text/html");
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));

    // Nothing image-shaped: let the browser paste text and formatting as usual.
    if (!images.length && !/<img/i.test(markup)) return;

    e.preventDefault();
    const range = saveSelection();
    setUploading(true);
    try {
      if (markup && /<img/i.test(markup)) {
        insertHtmlAt(range, await embedPastedImages(markup));
      } else {
        // A bare image on the clipboard — a screenshot, or "Copy image".
        const tags: string[] = [];
        for (const f of images) {
          const src = await uploadAsCid(f);
          if (src) tags.push(imgTag(src, f.name));
        }
        if (tags.length) insertHtmlAt(range, tags.join(""));
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    if (disabled) return;
    const images = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    e.preventDefault();
    const range = saveSelection();
    setUploading(true);
    try {
      const tags: string[] = [];
      for (const f of images) {
        const src = await uploadAsCid(f);
        if (src) tags.push(imgTag(src, f.name));
      }
      if (tags.length) insertHtmlAt(range, tags.join(""));
    } finally {
      setUploading(false);
    }
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
            <ToolbarButton title="Insert image" onClick={() => fileRef.current?.click()} disabled={disabled || uploading}>
              <ImageIcon className="h-3.5 w-3.5" />
            </ToolbarButton>
          </>
        )}
        {uploading && (
          <span className="ml-1 flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Embedding image…
          </span>
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
          onPaste={handlePaste}
          onDrop={handleDrop}
          className="min-h-[80px] px-3 py-2 text-sm outline-none [&_a]:text-brand-600 [&_a]:underline [&_img]:max-w-full"
        />
      </div>
    </div>
  );
}

function imgTag(src: string, name: string): string {
  return cidToPreview(`<img src="${src}" alt="${name.replace(/"/g, "")}" style="max-width:100%" />`);
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
