/**
 * Parser for trewellness.in's contact-form notification emails.
 *
 * The site runs several forms (Contact, Accommodation, Disease Management,
 * Offers, Packages, Therapies) that all notify the same inbox with a "Label :
 * value" run-on body — no consistent delimiter between fields beyond the next
 * recognized label, and every form uses a slightly different subset/order of
 * fields. Rather than hand-coding one parser per form (fragile the moment a
 * field is reordered or a new form is added), this scans the body for ANY
 * known label and takes each field's value as the text up to the next label
 * it finds — works across all current forms and tolerates minor future
 * changes to field order.
 *
 * Critically: every one of these notification emails arrives already
 * addressed hello@trewellness.in -> hello@trewellness.in (the site's own
 * mailer sends "as" the configured recipient) — the real customer's email is
 * only ever in the BODY. Treating the SMTP From header as the lead's contact
 * info would merge every single form submission into one guest record. See
 * resolveWebsiteFormLead() in inbound-mail.ts, which extracts contact info
 * from here instead of the envelope.
 */

export interface WebsiteFormLead {
  fullName: string;
  email: string | null;
  phone: string | null;
  age: number | null;
  city: string | null;
  businessName: string | null;
  businessRole: string | null;
  checkinDate: string | null;
  package: string | null;
  lookingFor: string | null;
  wellnessFocus: string | null;
  message: string | null;
  pageUrl: string | null;
  /** Landing-page forms only: the programme the page is for ("Sleep
   *  Restoration"), from the notification's subject line. */
  program?: string | null;
  /** Bridal landing page only. */
  weddingDate?: string | null;
}

const FIELD_BY_NORMALIZED_LABEL: Record<string, string> = {
  pageurl: "pageUrl",
  preferredcheckindate: "checkin",
  packagepreference: "package",
  wellnessfocus: "wellnessFocus",
  lookingfor: "lookingFor",
  areyoulookingfor: "lookingFor",
  phone: "phone",
  phonenumber: "phone",
  package: "package",
  message: "message",
  name: "name",
  age: "age",
  email: "email",
  city: "city",
  // Business name and role. The forms don't send these yet, so the label list
  // is deliberately wide: whichever wording the form ends up using, one of
  // these catches it without needing a code change first. "Occupation" is
  // here because the medical screening form already uses it for the same
  // thing.
  businessname: "businessName",
  companyname: "businessName",
  company: "businessName",
  organisation: "businessName",
  organization: "businessName",
  organisationname: "businessName",
  organizationname: "businessName",
  business: "businessName",
  role: "businessRole",
  designation: "businessRole",
  jobtitle: "businessRole",
  jobrole: "businessRole",
  occupation: "businessRole",
  profession: "businessRole",
};

// Ordered so a longer/more specific label (e.g. "Package Preference") is
// tried before a shorter one it starts with ("Package") — JS regex
// alternation picks the first alternative that matches at a given position,
// so array order is precedence order here.
const LABEL_RE =
  /\b(page\s*url|preferred\s*check[\s-]*in\s*date|package\s*preference|wellness\s*focus|(?:are\s*you\s*)?looking\s*for|phone(?:\s*number)?|business\s*name|company\s*name|organi[sz]ation\s*name|organi[sz]ation|designation|job\s*title|job\s*role|occupation|profession|company|business|package|message|name|age|email|city|role)\s*:/gi;

function normalizeLabel(raw: string): string {
  return raw.toLowerCase().replace(/[\s-]+/g, "");
}

/** Strip a leading "Mr"/"Ms"/"Mrs"/"Dr" (with optional period) from a name. */
function stripSalutation(name: string): string {
  return name.replace(/^(mr|ms|mrs|dr)\.?\s+/i, "").trim() || name;
}

/**
 * Bare 10-digit Indian mobiles (the norm on this form — no country code
 * field) get +91; anything already carrying a country code is normalized to
 * E.164. Returns null if it can't be made into a plausible E.164 number.
 */
function normalizeFormPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return /^\+[1-9]\d{6,14}$/.test(digits) ? digits : null;
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  const withPlus = `+${digits}`;
  return /^\+[1-9]\d{6,14}$/.test(withPlus) ? withPlus : null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * The form's date field into a real Date, or null when it's free text
 * ("sometime in August", "flexible") — the raw string is kept in the intake
 * notes either way, so nothing is lost by declining to guess.
 *
 * Anchored at UTC midnight. Every date here is a calendar date with no time
 * of day, and IST is UTC+5:30, so UTC midnight renders as the same calendar
 * day in IST — which is the only timezone this CRM displays.
 *
 * Ambiguous numeric dates are read DAY-first (15/08/2026), matching Indian
 * convention and the rest of the app. A value that can't be day-first (a
 * first component above 12, e.g. 2026-08-15) is read as ISO year-first.
 */
export function parseFormDate(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;

  // ISO: 2026-08-15
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (iso) return utcDate(+iso[1], +iso[2], +iso[3]);

  // Day-first numeric: 15/08/2026, 15-8-26
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (dmy) {
    const year = +dmy[3] < 100 ? 2000 + +dmy[3] : +dmy[3];
    return utcDate(year, +dmy[2], +dmy[1]);
  }

  // "15 Aug 2026" / "15 August 2026" / "Aug 15, 2026"
  const dMon = /^(\d{1,2})\s+([a-z]{3,})\.?,?\s+(\d{4})$/i.exec(s);
  if (dMon) {
    const mo = MONTHS[dMon[2].slice(0, 3).toLowerCase()];
    if (mo) return utcDate(+dMon[3], mo, +dMon[1]);
  }
  const monD = /^([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(s);
  if (monD) {
    const mo = MONTHS[monD[1].slice(0, 3).toLowerCase()];
    if (mo) return utcDate(+monD[3], mo, +monD[2]);
  }

  return null;
}

/** Rejects impossible dates (31 Feb) — Date would roll them into next month. */
function utcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null;
}

/**
 * Returns null when the body doesn't look like one of these form emails
 * (must have at least a Name and an Email) — callers fall back to normal
 * inbound-email handling in that case.
 */
export function parseWebsiteFormEmail(rawText: string): WebsiteFormLead | null {
  const text = rawText.replace(/\s+/g, " ").trim();
  if (!text) return null;

  const matches: Array<{ field: string; start: number; end: number }> = [];
  LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABEL_RE.exec(text))) {
    const field = FIELD_BY_NORMALIZED_LABEL[normalizeLabel(m[1])];
    if (field) matches.push({ field, start: m.index, end: LABEL_RE.lastIndex });
  }
  if (!matches.length) return null;

  const values: Record<string, string> = {};
  for (let i = 0; i < matches.length; i++) {
    const value = text.slice(matches[i].end, matches[i + 1]?.start ?? text.length).trim();
    if (value) values[matches[i].field] = value;
  }

  if (!values.name || !values.email) return null;

  const age = values.age ? parseInt(values.age, 10) : NaN;

  return {
    fullName: stripSalutation(values.name),
    email: values.email.toLowerCase(),
    phone: values.phone ? normalizeFormPhone(values.phone) : null,
    age: Number.isFinite(age) ? age : null,
    city: values.city ?? null,
    businessName: values.businessName ?? null,
    businessRole: values.businessRole ?? null,
    checkinDate: values.checkin ?? null,
    package: values.package ?? null,
    lookingFor: values.lookingFor ?? null,
    wellnessFocus: values.wellnessFocus ?? null,
    message: values.message ?? null,
    pageUrl: values.pageUrl ?? null,
  };
}

/** The leftover fields (beyond name/email/phone/city/business name/role,
 *  which map to Guest/Enquiry columns directly) formatted as intake notes. */
export function formatWebsiteFormNotes(lead: WebsiteFormLead): string | undefined {
  const lines: string[] = [];
  if (lead.age != null) lines.push(`Age: ${lead.age}`);
  if (lead.checkinDate) lines.push(`Preferred check-in: ${lead.checkinDate}`);
  if (lead.package) lines.push(`Package: ${lead.package}`);
  if (lead.lookingFor) lines.push(`Looking for: ${lead.lookingFor}`);
  if (lead.wellnessFocus) lines.push(`Wellness focus: ${lead.wellnessFocus}`);
  if (lead.program) lines.push(`Programme: ${lead.program}`);
  if (lead.weddingDate) lines.push(`Wedding date: ${lead.weddingDate}`);
  if (lead.pageUrl) lines.push(`Submitted via: ${lead.pageUrl}`);
  if (lead.message) lines.push(`Message: ${lead.message}`);
  return lines.length ? lines.join("\n") : undefined;
}

// ---------------------------------------------------------------------------
// Landing-page programme forms (added Sep 2026)
// ---------------------------------------------------------------------------

/**
 * The programme landing pages on trewellness.in — Weight Loss, Sleep
 * Restoration, Bridal, Harmonising Hormones — notify with a subject of the
 * form "New <Programme> Inquiry - trewellness.in" and a body the general
 * parser above can't read:
 *
 *   Your Name : Harsh Parekh Contact No : 7574841963 Email ID : x@y.com
 *   Wedding Date : 2026-10-10 Retreat Date : 2026-09-26 Thanks, Bridal
 *   Wellness Retreat trewellness.in Tel No.:- +91 87126 23060
 *
 * "Email ID" and "Contact No" aren't labels it knows, and the Sleep
 * Restoration form has no email at all — so every one of these fell through
 * to ordinary email handling and landed on the site's own sender, the
 * "trē wellness" guest. Two traps are handled here on purpose:
 *
 *  • the signature carries OUR number ("Tel No.:- +91 87126 23060"), so the
 *    body is cut at "Thanks," before any field is read;
 *  • phone-only submissions are accepted, which the general parser must never
 *    do (any email signature with "Name:" and "Phone:" would become a lead) —
 *    safe here only because the subject line has already identified the form.
 */
export const LANDING_FORM_SUBJECT_RE = /^\s*new\s+(.+?)\s+inquiry\s*-\s*trewellness\.in\s*$/i;

/** The page each programme's form lives on — the email doesn't say. */
const LANDING_PAGE_URL: Record<string, string> = {
  "weight loss management": "https://trewellness.in/weightloss/",
  "sleep restoration": "https://trewellness.in/sleep-restoration/",
  "bridal campaign": "https://trewellness.in/bridal/",
  "harmonising hormones": "https://trewellness.in/harmonising-hormones/",
};

const LANDING_FIELD: Record<string, "name" | "phone" | "email" | "dates" | "program" | "wedding"> = {
  yourname: "name",
  name: "name",
  fullname: "name",
  contactno: "phone",
  contactnumber: "phone",
  phonenumber: "phone",
  phone: "phone",
  emailid: "email",
  emailaddress: "email",
  email: "email",
  retreatdates: "dates",
  retreatdate: "dates",
  tentativeretreatdates: "dates",
  preferreddates: "dates",
  preferreddate: "dates",
  dates: "dates",
  preferredprogram: "program",
  weddingdate: "wedding",
};

// Longest alternatives first — alternation takes the first that matches.
const LANDING_LABEL_RE =
  /\b(tentative\s*retreat\s*dates?|retreat\s*dates?|preferred\s*dates?|preferred\s*program(?:me)?|wedding\s*date|your\s*name|full\s*name|contact\s*(?:no|number)\.?|phone\s*number|email\s*(?:id|address)|phone|email|dates|name)\s*:/gi;

/** The programme named in a landing-page notification's subject, or null
 *  when the subject isn't one. Replies ("Re: New …") are not submissions. */
export function landingFormProgram(subject: string | null | undefined): string | null {
  const m = subject ? LANDING_FORM_SUBJECT_RE.exec(subject) : null;
  return m ? m[1].trim() : null;
}

/**
 * Parse a landing-page programme form. Returns null unless the subject is one
 * of these notifications AND the body yields a name plus a phone or email —
 * callers then fall back to normal handling rather than guessing.
 */
export function parseLandingPageForm(subject: string | null | undefined, rawText: string): WebsiteFormLead | null {
  const program = landingFormProgram(subject);
  if (!program) return null;

  // Everything from "Thanks," on is the site's signature — including our own
  // phone number, which must never be read as the guest's.
  const text = rawText.replace(/\s+/g, " ").split(/\s+thanks\s*,/i)[0].trim();

  const found: Array<{ field: string; start: number; end: number }> = [];
  LANDING_LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LANDING_LABEL_RE.exec(text))) {
    const field = LANDING_FIELD[m[1].toLowerCase().replace(/[^a-z]/g, "")];
    if (field) found.push({ field, start: m.index, end: LANDING_LABEL_RE.lastIndex });
  }

  const values: Record<string, string> = {};
  for (let i = 0; i < found.length; i++) {
    const value = text.slice(found[i].end, found[i + 1]?.start ?? text.length).trim();
    // First occurrence wins: the fields come before anything free-text.
    if (value && !values[found[i].field]) values[found[i].field] = value;
  }

  const name = values.name ? stripSalutation(values.name) : "";
  const email = values.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) ? values.email.toLowerCase() : null;
  const phone = values.phone ? normalizeFormPhone(values.phone) : null;
  if (!name || (!email && !phone)) return null;

  return {
    fullName: name,
    email,
    phone,
    age: null,
    city: null,
    businessName: null,
    businessRole: null,
    checkinDate: values.dates ?? null,
    package: values.program ?? null,
    lookingFor: null,
    wellnessFocus: null,
    message: null,
    pageUrl: LANDING_PAGE_URL[program.toLowerCase()] ?? null,
    program,
    weddingDate: values.wedding ?? null,
  };
}
