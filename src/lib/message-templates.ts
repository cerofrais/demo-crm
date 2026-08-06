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
