/**
 * Message-template types + personalization — shared (client + server), no
 * DB/node deps, safe to import from "use client" components. Templates
 * themselves are DB-backed (MessageTemplate) and managed via
 * /message-templates (Admin/Manager) and served through /api/message-templates
 * — see message-templates-service.ts for the server-side CRUD.
 */

export type MessageTemplateChannel = "email" | "whatsapp";

export interface MessageTemplateDTO {
  id: string;
  channel: MessageTemplateChannel;
  name: string;
  subject: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** Set when archived. Archived templates never appear in a picker, and only
   *  appear on the templates page when "Show archived" is ticked. */
  archivedAt: string | null;
  /** The folder it is filed in. Null only while a deleted folder's contents
   *  are being moved; the page always files a template somewhere. */
  folderId: string | null;
  /** "Detox / Pricing shared" — resolved server-side so a picker needs no
   *  second request to show where a template lives. */
  folderPath: string | null;
}

export interface PersonalizeVars {
  /** Guest/lead full name — {name} resolves to just the first name. */
  name?: string;
  /** Guest's Guest.gender ("male" | "female" | "other" | null) — {salutation}
   *  resolves to "Mr. " / "Ms. " / "" respectively, so "Hi {salutation}{name},"
   *  reads as "Hi Mr. Arjun," / "Hi Ms. Divya," / "Hi Karan," (unknown/other:
   *  first name only, no guessed title). */
  gender?: string | null;
  /** Sending staff member's own name/phone (StaffProfile). */
  repName?: string;
  repPhone?: string;
}

function salutationFor(gender: string | null | undefined): string {
  if (gender === "male") return "Mr. ";
  if (gender === "female") return "Ms. ";
  return "";
}

/** Resolves whichever of {name}/{salutation}/{rep_name}/{rep_phone} are
 * present in `vars` — any token whose var is omitted is left untouched, so
 * partial personalization (e.g. bulk sends resolve rep_* immediately but
 * leave {name}/{salutation} for send time) is just "don't pass that var". */
export function personalizeTemplate(text: string, vars: PersonalizeVars): string {
  let out = text;
  if (vars.name !== undefined) {
    const firstName = vars.name.trim().split(/\s+/)[0] || vars.name;
    out = out.replace(/\{name\}/gi, firstName);
  }
  if (vars.gender !== undefined) out = out.replace(/\{salutation\}/gi, salutationFor(vars.gender));
  if (vars.repName !== undefined) out = out.replace(/\{rep_name\}/gi, vars.repName);
  if (vars.repPhone !== undefined) out = out.replace(/\{rep_phone\}/gi, vars.repPhone);
  return out;
}

/**
 * Does this body carry its own markup?
 *
 * Email templates are authored in the rich editor and ARE html; the ones
 * written before that editor existed — and every WhatsApp template — are
 * plain text, where the newlines carry the formatting.
 */
export function looksLikeHtml(body: string): boolean {
  return /<(?:p|div|br|img|a|ul|ol|li|b|strong|i|em|u|h[1-3]|blockquote|span)\b[^>]*>/i.test(body);
}

/**
 * A template body as html for the compose box.
 *
 * The newline-to-<br> conversion is only right for a PLAIN body. Running it
 * over html would put a line break after every tag that already sits on its
 * own line, double-spacing the whole message — which is what would happen to
 * every existing template the moment rich ones became possible.
 */
export function templateBodyToHtml(body: string): string {
  return looksLikeHtml(body) ? body : body.replace(/\n/g, "<br>");
}

/**
 * The plain-text half of an html body, for the text/plain MIME part and for
 * anything that stores a searchable copy. Deliberately crude — it only has
 * to undo what the rich editor can produce.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-3])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A template body as readable text, for previews and list rows.
 *
 * Rich bodies would otherwise show their own markup — "<p>Hi {name},</p>" —
 * on every card. Plain bodies pass through untouched so a rep who typed a
 * literal angle bracket still sees it.
 */
export function templateBodyPreview(body: string): string {
  return looksLikeHtml(body) ? htmlToPlainText(body) : body;
}
