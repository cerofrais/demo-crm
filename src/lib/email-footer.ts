/**
 * The signature block appended to every outgoing email.
 *
 * Applied inside sendEmail() rather than at each call site. There are four
 * places that send mail (the rep composer, bulk email, the welcome mail and
 * the marketing report) and "every outgoing email" has to stay true as a
 * fifth is added — a footer you have to remember to add is one that will be
 * missing somewhere.
 *
 * IMAGES ARE cid: ATTACHMENTS, NOT URLS.
 * A remote <img> needs a permanently public URL, which this deployment has
 * no way to mint: files live in MinIO behind presigned links that expire, so
 * a footer image would render for a few hours and then break in every copy
 * already delivered — including ones sitting in a guest's inbox months later.
 * The editor therefore stores `<img src="cid:<documentId>">` — the same
 * convention the compose box and bulk email already use — and mail-html.ts
 * turns each of those into a real MIME part at send time.
 */
import { prisma } from "./prisma";
import { logger } from "./logger";
import {
  extractCidImageIds,
  buildInlineImageAttachments,
  sanitizeEmailHtml,
  type InlineImageAttachment,
} from "./mail-html";

const FOOTER_ID = "default";

export interface EmailFooterDTO {
  enabled: boolean;
  html: string;
  text: string;
  updatedBy: string | null;
  updatedAt: string | null;
}

export const EMPTY_FOOTER: EmailFooterDTO = {
  enabled: true,
  html: "",
  text: "",
  updatedBy: null,
  updatedAt: null,
};

export async function getEmailFooter(): Promise<EmailFooterDTO> {
  const row = await prisma.emailFooter.findUnique({ where: { id: FOOTER_ID } });
  if (!row) return EMPTY_FOOTER;
  return {
    enabled: row.enabled,
    html: row.html,
    text: row.text,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function saveEmailFooter(input: {
  enabled: boolean;
  html: string;
  text: string;
  updatedBy: string;
}): Promise<EmailFooterDTO> {
  // Sanitized on the way in, like every other HTML body that leaves the
  // server — this one is copied onto EVERY outgoing email, so a bad tag here
  // would be reproduced thousands of times rather than once.
  const clean = { ...input, html: sanitizeEmailHtml(input.html) };
  const row = await prisma.emailFooter.upsert({
    where: { id: FOOTER_ID },
    create: { id: FOOTER_ID, ...clean },
    update: clean,
  });
  return {
    enabled: row.enabled,
    html: row.html,
    text: row.text,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The footer's inline images, as MIME parts.
 *
 * Defers to mail-html.ts rather than repeating its cid convention: the
 * compose box, bulk email and this footer must all agree on what
 * `<img src="cid:…">` means, and RichTextEditor already emits that form.
 * Unscoped by guest — a signature image is a shared asset that goes to
 * everyone, the same as a broadcast attachment.
 */
export async function loadFooterImages(html: string): Promise<InlineImageAttachment[]> {
  const ids = extractCidImageIds(html);
  if (!ids.length) return [];
  try {
    return await buildInlineImageAttachments(ids);
  } catch (err) {
    // A broken logo is cosmetic; an email that never goes out because of one
    // is not. The <img> is left pointing at a cid with no part, which renders
    // as a missing image — same outcome, without losing the message.
    logger.warn({ err }, "email footer: images unreadable, sending without them");
    return [];
  }
}

/**
 * Join a body and the footer.
 *
 * Exported separately from the DB read so the joining rules are testable
 * without a database — they carry the decisions:
 *   • an empty footer changes nothing, including no stray separator;
 *   • the HTML part only gets the footer when there IS an HTML part, so a
 *     plain-text send is not silently upgraded into multipart;
 *   • the text footer is separated by the conventional "-- " sig marker,
 *     which mail clients use to collapse signatures.
 */
export function joinFooter(
  body: { text: string; html?: string },
  footer: { html: string; text: string },
): { text: string; html?: string } {
  const footText = footer.text.trim();
  const footHtml = footer.html.trim();

  const text = footText ? `${body.text}\n\n-- \n${footText}` : body.text;
  const html =
    body.html && footHtml
      ? `${body.html}<div class="tre-email-footer" style="margin-top:24px">${footHtml}</div>`
      : body.html;

  return { text, html };
}

/**
 * The footer as it should be applied to one outgoing message: the joined
 * body plus any inline images it needs. Returns the body untouched when no
 * footer is configured or it is switched off.
 */
export async function applyEmailFooter(body: {
  text: string;
  html?: string;
}): Promise<{ text: string; html?: string; attachments: InlineImageAttachment[] }> {
  let footer: EmailFooterDTO;
  try {
    footer = await getEmailFooter();
  } catch (err) {
    // The footer is decoration; the message is not. A database hiccup here
    // must not stop mail going out.
    logger.error({ err }, "email footer: could not load, sending without it");
    return { ...body, attachments: [] };
  }
  if (!footer.enabled || (!footer.html.trim() && !footer.text.trim())) {
    return { ...body, attachments: [] };
  }

  const joined = joinFooter(body, footer);
  // Only load images the joined HTML actually references — a footer whose
  // text half is used alone needs none.
  const attachments = joined.html ? await loadFooterImages(footer.html) : [];
  return { ...joined, attachments };
}
