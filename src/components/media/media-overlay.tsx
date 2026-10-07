"use client";

/**
 * An image, a recording or a video, opened over the page instead of in a new
 * tab.
 *
 * A new tab loses the place you were in: the lead you were reading, the filter
 * you had set, the row you were half way down. Looking at a photo someone sent
 * is a glance, not a journey — so it opens here, over the page, and closes back
 * onto exactly what you were doing.
 *
 * Built on Dialog, which already handles the backdrop, Escape, the focus trap
 * and the close button, so there is one set of overlay behaviour in the app
 * rather than two.
 */

import { Download } from "lucide-react";
import { Dialog } from "@/components/ui";

export interface OverlayMedia {
  id: string;
  filename: string;
  mimeType: string;
}

/** The file types worth opening over the page rather than downloading. */
export function isOverlayable(mimeType: string): boolean {
  return (
    mimeType.startsWith("image/") || mimeType.startsWith("audio/") || mimeType.startsWith("video/")
  );
}

export function MediaOverlay({
  media,
  onClose,
  /** For a call recording, whose bytes come from the call route, not a file. */
  srcOverride,
  title,
}: {
  media: OverlayMedia | null;
  onClose: () => void;
  srcOverride?: string;
  title?: string;
}) {
  if (!media) return null;
  const src = srcOverride ?? `/api/files/${media.id}?inline=1`;
  const downloadHref = srcOverride ?? `/api/files/${media.id}`;

  return (
    <Dialog open onClose={onClose} title={title ?? media.filename} className="md:max-w-3xl">
      <div className="flex max-h-[75dvh] flex-col gap-3 overflow-auto bg-background px-4 py-4 md:px-6">
        {media.mimeType.startsWith("image/") && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={media.filename}
            className="mx-auto max-h-[65dvh] w-auto max-w-full rounded-md object-contain"
          />
        )}
        {media.mimeType.startsWith("audio/") && (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <audio controls autoPlay src={src} className="w-full" />
        )}
        {media.mimeType.startsWith("video/") && (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video controls src={src} className="mx-auto max-h-[65dvh] w-auto max-w-full rounded-md" />
        )}
        <a
          href={downloadHref}
          download={media.filename}
          className="flex w-fit items-center gap-1.5 self-end rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
        >
          <Download className="h-3.5 w-3.5" /> Download
        </a>
      </div>
    </Dialog>
  );
}
