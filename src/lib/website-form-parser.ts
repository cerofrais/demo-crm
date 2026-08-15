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
  checkinDate: string | null;
  package: string | null;
  lookingFor: string | null;
  wellnessFocus: string | null;
  message: string | null;
  pageUrl: string | null;
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
};

// Ordered so a longer/more specific label (e.g. "Package Preference") is
// tried before a shorter one it starts with ("Package") — JS regex
// alternation picks the first alternative that matches at a given position,
// so array order is precedence order here.
const LABEL_RE =
  /\b(page\s*url|preferred\s*check[\s-]*in\s*date|package\s*preference|wellness\s*focus|(?:are\s*you\s*)?looking\s*for|phone(?:\s*number)?|package|message|name|age|email|city)\s*:/gi;

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
    checkinDate: values.checkin ?? null,
    package: values.package ?? null,
    lookingFor: values.lookingFor ?? null,
    wellnessFocus: values.wellnessFocus ?? null,
    message: values.message ?? null,
    pageUrl: values.pageUrl ?? null,
  };
}

/** The leftover fields (beyond name/email/phone/city, which map to Guest/
 *  Enquiry columns directly) formatted as intake notes. */
export function formatWebsiteFormNotes(lead: WebsiteFormLead): string | undefined {
  const lines: string[] = [];
  if (lead.age != null) lines.push(`Age: ${lead.age}`);
  if (lead.checkinDate) lines.push(`Preferred check-in: ${lead.checkinDate}`);
  if (lead.package) lines.push(`Package: ${lead.package}`);
  if (lead.lookingFor) lines.push(`Looking for: ${lead.lookingFor}`);
  if (lead.wellnessFocus) lines.push(`Wellness focus: ${lead.wellnessFocus}`);
  if (lead.pageUrl) lines.push(`Submitted via: ${lead.pageUrl}`);
  if (lead.message) lines.push(`Message: ${lead.message}`);
  return lines.length ? lines.join("\n") : undefined;
}
