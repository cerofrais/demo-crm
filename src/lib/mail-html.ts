import sanitizeHtml from "sanitize-html";
import { prisma } from "./prisma";
import { getObjectBuffer, headObject } from "./storage";

/**
 * Rich-text email bodies come from a staff member's own contentEditable
 * compose box, not an external/guest submission — but browser paste-from-
 * Word and execCommand quirks can still smuggle in junk markup, so this is
 * sanitized before it's ever handed to nodemailer or persisted, same as any
 * HTML that leaves the server. Deliberately narrow: only what the compose
 * toolbar can actually produce.
 */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "p", "br", "div", "span", "b", "strong", "i", "em", "u",
      "a", "img", "ul", "ol", "li", "h1", "h2", "h3", "blockquote",
    ],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt", "width", "height"],
    },
    // cid: is how an inline image references its own attachment (see
    // extractCidImageIds below) — http(s) covers a pasted external image URL.
    allowedSchemesByTag: { img: ["http", "https", "cid"] },
    // tel: so a phone number in a signature can be tapped to call. Without it
    // the sanitizer silently dropped the href and left a link-styled number
    // that did nothing — which is what the saved footer's phones had become.
    allowedSchemes: ["http", "https", "mailto", "tel"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
    },
  });
}

const CID_RE = /cid:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Every Document id an email body's <img src="cid:..."> tags reference. */
export function extractCidImageIds(html: string | null | undefined): string[] {
  if (!html) return [];
  const ids = new Set<string>();
  for (const m of html.matchAll(CID_RE)) ids.add(m[1].toLowerCase());
  return [...ids];
}

const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

export interface InlineImageAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  cid: string;
}

/**
 * Resolves cid-referenced Documents into nodemailer-ready inline attachments.
 * `guestId`, when given, scopes the lookup the same way the existing
 * single-file attachment is scoped — a compose box can only embed images it
 * uploaded for that guest. Bulk email has no single guest to scope to (the
 * image is a shared broadcast asset uploaded by the same authenticated
 * sender), so it's left unscoped there.
 */
export async function buildInlineImageAttachments(
  ids: string[],
  guestId?: string,
): Promise<InlineImageAttachment[]> {
  if (!ids.length) return [];
  const docs = await prisma.document.findMany({
    where: { id: { in: ids }, ...(guestId ? { guestId } : {}) },
  });
  const out: InlineImageAttachment[] = [];
  for (const doc of docs) {
    const head = await headObject(doc.storageKey).catch(() => null);
    if (!head || head.contentLength > MAX_INLINE_IMAGE_BYTES) continue;
    const content = await getObjectBuffer(doc.storageKey);
    out.push({ filename: doc.filename, content, contentType: doc.mimeType, cid: doc.id });
  }
  return out;
}
