/**
 * Which parts of a received email are attachments the sender meant to attach.
 *
 * Mailparser reports every non-body part, and most of them are not
 * attachments in the sense a person means: a signature logo, a pasted image,
 * an embedded icon. Those are referenced from the HTML body and shown in
 * place. Counting them would put a paperclip on nearly every email that has a
 * logo in its signature, and the icon would stop meaning anything.
 */

export interface ParsedAttachmentLike {
  filename?: string | null;
  contentType?: string | null;
  contentDisposition?: string | null;
  /** Mailparser sets this for a part the HTML body references by cid. */
  related?: boolean;
  cid?: string | null;
}

/** Filenames of the real attachments, in the order they appear. */
export function realAttachmentNames(parts: ParsedAttachmentLike[] | null | undefined): string[] {
  const out: string[] = [];
  for (const p of parts ?? []) {
    if (p.related) continue;
    // Shown inline by reference: part of the body, not an attachment.
    if (p.contentDisposition === "inline" && p.cid) continue;
    out.push(p.filename?.trim() || fallbackName(p.contentType));
  }
  return out;
}

function fallbackName(contentType: string | null | undefined): string {
  const sub = contentType?.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
  return sub && /^[a-z0-9.+-]{1,20}$/.test(sub) ? `attachment.${sub.replace("jpeg", "jpg")}` : "attachment";
}
