import { ALLERGY_OPTIONS, type HealthRecord } from "./health";

/**
 * Parser for trewellness.in's "Pre-Booking Guest Medical Screening Form"
 * notification emails (subject contains "Pre-Booking Guest Medical Screening
 * Form" — checked by the caller, not here).
 *
 * The WordPress plugin behind this form renders the same submission as plain
 * text in at least three different shapes depending on the guest's mail
 * client / plugin version: one label per line with its answer on the line(s)
 * below; the same but with labels wrapped in markdown asterisks and long
 * questions word-wrapped across lines; and — the one that broke a purely
 * line-based parser — a single continuous word-wrapped paragraph with NO
 * line break between a label and its own answer at all (e.g. "First Name
 * Siddharth Last Name Reddy Age 35 Date of Birth 13101990 ...").
 *
 * Rather than parse line-by-line, this scans the ENTIRE message body for
 * occurrences of each known question's text (tolerant of line wraps, since
 * whitespace in the pattern matches across a newline) and treats the text
 * between one recognized label and the next — regardless of whether that
 * span happens to contain line breaks — as that label's answer. This one
 * mechanism handles all three known layouts without special-casing any of
 * them, and keeps working if a future submission mixes layouts within the
 * same email.
 */

export interface MedicalFormContact {
  fullName: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  gender: string | null;
  dateOfBirth: string | null; // ISO yyyy-mm-dd, or null if unparseable
  /** No home on Guest or HealthRecord — surfaced via formatMedicalFormNotes(). */
  fatherSpouseName: string | null;
  heardAboutUs: string | null;
}

export interface MedicalFormSubmission {
  contact: MedicalFormContact;
  health: Partial<HealthRecord>;
}

type FieldKey =
  | "firstName" | "lastName" | "dateOfBirth" | "fatherSpouseName" | "gender"
  | "phone" | "email" | "city" | "heardAboutUs"
  // Present in some submissions (surname titles, passport/visa details for
  // international guests, a returning guest's previous admission date) but
  // with no home on Guest or HealthRecord — recognized purely so their text
  // doesn't bleed into whichever real field precedes them.
  | "ignore"
  | keyof HealthRecord;

/** Ordered by appearance in the real form — order doesn't matter for
 *  matching (each is searched for independently), only for readability. */
const LABELS: Array<{ label: string; field: FieldKey }> = [
  { label: "First Name", field: "firstName" },
  { label: "Last Name", field: "lastName" },
  { label: "Age", field: "ignore" },
  { label: "Date of Birth", field: "dateOfBirth" },
  { label: "Father/Spouse name", field: "fatherSpouseName" },
  { label: "Gender", field: "gender" },
  { label: "Height (in cms)", field: "heightCm" },
  { label: "Weight (in kgs)", field: "weightKg" },
  { label: "Blood group", field: "bloodGroup" },
  { label: "Occupation", field: "occupation" },
  { label: "Marital status", field: "maritalStatus" },
  { label: "Mobile Number", field: "phone" },
  { label: "Email", field: "email" },
  { label: "City", field: "city" },
  { label: "Address", field: "address" },
  { label: "Emergency contact name & contact number", field: "emergencyContact" },
  { label: "Do you have any health issues?", field: "hasHealthIssues" },
  { label: "List your health issues", field: "healthIssues" },
  { label: "List your current Medications / Supplements", field: "medications" },
  { label: "1) Have you undergone any surgery in recent years?", field: "recentSurgeries" },
  { label: "2) Are you suffering from any infectious disease or skin disease?", field: "infectiousSkinDisease" },
  { label: "3) Are you suffering from any heart disease or have undergone angioplasty/bypass/open heart surgery?", field: "heartDisease" },
  { label: "4) Do you have any past/present history of psychiatric medication/intervention?", field: "psychiatricHistory" },
  { label: "5) Are you suffering from any kind of kidney/ liver/ lung disease?", field: "kidneyLiverLung" },
  { label: "6) Did you have any episodes of seizure/epilepsy in the past 5 years?", field: "seizures" },
  { label: "7) Do you suffer from any type of hernia?", field: "hernia" },
  { label: "8) Are you physically or visually disabled in anyway?", field: "disability" },
  { label: "9) Can you walk 1 Kilometre without support?", field: "canWalk1km" },
  { label: "10) Are you suffering from any allergies?", field: "allergies" },
  { label: "11) Have you become reliant on any of the below substances?", field: "substanceReliance" },
  // "From"/"To" (the check-in/check-out dates) are deliberately NOT anchors
  // here — as bare one-word labels, scanning the whole document for them
  // would false-match ordinary occurrences of "to" in free-text answers.
  // They're extracted from inside the purposeOfVisit span instead — see
  // splitPurposeAndDates() below.
  { label: "12) Purpose of your visit to trē wellness?", field: "purposeOfVisit" },
  { label: "14) Preferred type of accommodation", field: "accommodationType" },
  { label: "Previous date of admission", field: "ignore" },
  { label: "How did you come to know about trē wellness?", field: "heardAboutUs" },
  { label: "Have you been to any other naturopathy / ayurveda / wellness centre before?", field: "priorWellnessExperience" },
  { label: "If yes, please mention name and duration of stay", field: "priorWellnessDetails" },
  { label: "Passport number", field: "ignore" },
  { label: "Date of issue", field: "ignore" },
  { label: "Place of issue", field: "ignore" },
  { label: "Visa duration", field: "ignore" },
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a regex that finds this label's text anywhere in a raw message
 * body — tolerant of a line wrap in the middle of the label (\s+ between
 * words matches a newline too), an optional leading "N) " (any digits, so a
 * future re-numbering doesn't break it), and "trē" vs "tre". Boundaries use
 * lookaround rather than \b so a label ending in punctuation (most of them,
 * being questions) still can't match as a substring of a longer word.
 */
function buildLabelPattern(label: string): RegExp {
  const core = label.replace(/^\d+\)\s*/, "");
  const words = core.split(/\s+/).filter(Boolean).map((w) => {
    const escaped = escapeRegex(w);
    return /tr[eē]/i.test(w) ? escaped.replace(/tr[eē]/i, "tr[eē]") : escaped;
  });
  const corePattern = words.join("\\s+");
  return new RegExp(
    `(?<![a-zA-Z0-9])(?:\\d+\\)\\s*)?${corePattern}(?![a-zA-Z0-9])`,
    "gi",
  );
}

const LABEL_PATTERNS = LABELS.map((l) => ({ field: l.field, regex: buildLabelPattern(l.label) }));

const CONTACT_FIELDS = new Set<FieldKey>([
  "firstName", "lastName", "dateOfBirth", "fatherSpouseName", "gender",
  "phone", "email", "city", "heardAboutUs",
]);

// Multi-line answers (checkbox questions) keep every line as a separate array
// entry; everything else joins wrapped lines with a space into one string.
// (allergies is handled separately below — it also has a companion
// allergyDetails free-text field a "Please explain in detail:" follow-up
// needs to land in, unlike substanceReliance which has no detail field.)
const ARRAY_FIELDS = new Set<FieldKey>(["substanceReliance"]);
const JOIN_WITH_COMMA = new Set<FieldKey>(["healthIssues"]);
const YES_NO_DETAIL_FIELDS = new Set<FieldKey>([
  "recentSurgeries", "infectiousSkinDisease", "heartDisease", "psychiatricHistory",
  "kidneyLiverLung", "seizures", "hernia", "disability", "canWalk1km",
]);

/** Extracts a leading yes/no/none token from freeform text (the rest of the
 *  line often runs straight into the question's own "if yes, please
 *  specify" follow-up with no separator at all in the flattened-paragraph
 *  layout) — "none" is checked before "no" since it's the longer match. */
function extractLeadingFlag(text: string): { flag: boolean; rest: string } | null {
  const m = /^\s*(none|yes|no)\b/i.exec(text);
  if (!m) return null;
  return { flag: m[1].toLowerCase() === "yes", rest: text.slice(m[0].length) };
}

/**
 * A yes/no question's own conditional follow-up prompt ("If yes, please
 * give details:", "Please explain in detail:", "If others, please
 * specify") sometimes runs directly into the guest's actual answer with no
 * separator besides the prompt's own trailing colon (or, for "If others,
 * please specify", no colon at all — trimmed to whatever text follows
 * "please <verb...>"). Its exact wording differs per question and isn't
 * hard-coded here for every one of them — stripped generically so it
 * doesn't get glued onto the front of the guest's answer.
 */
function stripLeadingPrompt(text: string): string {
  const cleaned = text.trim();
  const withColon = /^(?:if\s+\w+\s*,?\s*)?please\s+[^:]*:\s*/i.exec(cleaned);
  if (withColon) return cleaned.slice(withColon[0].length).trim();
  const noColon = /^(?:if\s+\w+\s*,?\s*)?please\s+\S+(?:\s+\S+){0,4}\s+/i.exec(cleaned);
  if (noColon) return cleaned.slice(noColon[0].length).trim();
  return cleaned;
}

/** For a plain contact field whose value might run straight into its own
 *  "If <x>, please specify" follow-up (e.g. "How did you come to know
 *  about us?" -> "Others If others, please specify ..."), keep only the
 *  answer itself. */
function stripTrailingIfClause(text: string): string {
  const m = /^(.*?)\s+if\s+\w+\b/i.exec(text);
  return (m ? m[1] : text).trim();
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function monthIndex(word: string): number {
  const w = word.toLowerCase();
  return MONTHS.findIndex((m) => m === w || (w.length >= 3 && m.startsWith(w)));
}

/**
 * Parses "28th November 1995", "23/01/2000", "19-12-1974", "28/10/ 1997"
 * (stray whitespace around the separator), "29 oct 1987" (abbreviated
 * month), and "13101990" (DDMMYYYY with no separators at all) -> ISO
 * yyyy-mm-dd, or null if unparseable. Built from the numeric day/month/year
 * parts directly (Date.UTC), not by handing the string to the Date
 * constructor — a date-only string with no explicit timezone parses as
 * LOCAL midnight there, which then shifts by a day off ISO/UTC depending on
 * the server's timezone offset.
 */
function parseFormDate(raw: string): string | null {
  const cleaned = raw.trim().replace(/(\d+)\s*(st|nd|rd|th)\b/i, "$1");

  const named = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i.exec(cleaned);
  if (named) {
    const day = parseInt(named[1], 10);
    const month = monthIndex(named[2]);
    const year = parseInt(named[3], 10);
    if (month === -1 || day < 1 || day > 31) return null;
    return toIsoDate(year, month, day);
  }

  // DD/MM/YYYY or DD-MM-YYYY — Indian convention, optional stray whitespace.
  const numeric = /^(\d{1,2})\s*[/-]\s*(\d{1,2})\s*[/-]\s*(\d{4})$/.exec(cleaned);
  if (numeric) {
    const day = parseInt(numeric[1], 10);
    const month = parseInt(numeric[2], 10) - 1;
    const year = parseInt(numeric[3], 10);
    if (day < 1 || day > 31 || month < 0 || month > 11) return null;
    return toIsoDate(year, month, day);
  }

  // DDMMYYYY with no separator at all.
  const compact = /^(\d{2})(\d{2})(\d{4})$/.exec(cleaned);
  if (compact) {
    const day = parseInt(compact[1], 10);
    const month = parseInt(compact[2], 10) - 1;
    const year = parseInt(compact[3], 10);
    if (day < 1 || day > 31 || month < 0 || month > 11) return null;
    return toIsoDate(year, month, day);
  }

  return null;
}

/** Built from explicit UTC components, not the Date constructor's string
 *  parsing — a date-only string with no explicit timezone parses as LOCAL
 *  midnight there, which then shifts by a day off ISO/UTC depending on the
 *  server's timezone offset. */
function toIsoDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month, day));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Bare 10-digit Indian mobiles get +91; anything already carrying a country
 * code is normalized to E.164. Returns null if it can't be made plausible.
 */
function normalizeFormPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return /^\+[1-9]\d{6,14}$/.test(digits) ? digits : null;
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  const withPlus = `+${digits}`;
  return /^\+[1-9]\d{6,14}$/.test(withPlus) ? withPlus : null;
}

interface Anchor {
  field: FieldKey;
  start: number;
  end: number;
}

/** Finds every known label's occurrence in the text, then keeps only a
 *  non-overlapping, position-ordered subset (earliest start wins; on a tie,
 *  the longer match wins) — a label embedded inside another's answer text
 *  can't happen with real submissions, but this keeps the result well
 *  defined even if it ever does. */
function findAnchors(text: string): Anchor[] {
  const all: Anchor[] = [];
  for (const { field, regex } of LABEL_PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text))) {
      all.push({ field, start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) regex.lastIndex += 1;
    }
  }
  all.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const result: Anchor[] = [];
  let cursor = -1;
  for (const a of all) {
    if (a.start < cursor) continue;
    result.push(a);
    cursor = a.end;
  }
  return result;
}

/** The text between one anchor and the next, split back into lines so
 *  multi-select (checkbox) answers that DO still land on their own line
 *  (every real submission's checklists do, even the ones with no line break
 *  between a plain label and its own single-line answer) stay separate
 *  array entries; a trailing mailer signature is dropped defensively in
 *  case it isn't caught by a following anchor. */
function buildSpans(text: string, anchors: Anchor[]): Map<FieldKey, string[]> {
  const map = new Map<FieldKey, string[]>();
  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i].end;
    const end = i + 1 < anchors.length ? anchors[i + 1].start : text.length;
    const lines = text
      .slice(start, end)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^sent from\b/i.test(l));
    if (!lines.length) continue;
    map.set(anchors[i].field, [...(map.get(anchors[i].field) ?? []), ...lines]);
  }
  return map;
}

/**
 * The visit-purpose checklist and its check-in/check-out dates run together
 * with no separator in the flattened layout ("...Rejuvenation From
 * 2026-08-05 To 2026-08-20"). Pulled apart with one bounded regex instead of
 * treating "From"/"To" as document-wide anchors, which would false-match
 * the ordinary word "to" anywhere in free-text answers.
 */
function splitPurposeAndDates(
  fieldLines: string[],
): { purpose: string[]; checkIn: string | null; checkOut: string | null } {
  const joined = fieldLines.join("\n");
  const m = /^([\s\S]*?)\bFrom\s+([\s\S]+?)\s+To\s+([\s\S]+)$/i.exec(joined);
  if (!m) return { purpose: fieldLines, checkIn: null, checkOut: null };
  const purpose = m[1].split("\n").map((l) => l.trim()).filter(Boolean);
  return { purpose, checkIn: m[2].trim(), checkOut: m[3].trim() };
}

/** Splits a checkbox-answer span into recognized options vs. free-text
 *  detail. Handles both a real option landing on its own exact line (the
 *  common case) and one glued straight onto the label with no line break at
 *  all, immediately followed by its "please explain" follow-up. */
function parseAllergies(fieldLines: string[]): { options: string[]; detail: string } {
  const isExactOption = (l: string) =>
    (ALLERGY_OPTIONS as readonly string[]).some((o) => o.toLowerCase() === l.toLowerCase());
  const options: string[] = [];
  const remainder: string[] = [];
  for (const l of fieldLines) {
    if (isExactOption(l)) options.push(l.trim());
    else remainder.push(l);
  }
  let text = remainder.join(" ").trim();
  const byLength = [...ALLERGY_OPTIONS].sort((a, b) => b.length - a.length);
  for (const o of byLength) {
    if (text.toLowerCase().startsWith(o.toLowerCase())) {
      const after = text.slice(o.length);
      if (after === "" || /^[^a-z0-9]/i.test(after)) {
        options.push(o);
        text = after.trim();
        break;
      }
    }
  }
  return { options, detail: stripLeadingPrompt(text) };
}

/**
 * Returns null if the body doesn't contain at least a name and a phone
 * number — callers fall back to normal inbound-email handling in that case.
 */
export function parseMedicalScreeningForm(rawText: string): MedicalFormSubmission | null {
  // Markdown asterisks around a label are pure decoration in every known
  // layout — stripped once up front rather than tolerated at every site
  // that reads captured text.
  const text = rawText.replace(/\r\n/g, "\n").replace(/\*/g, "");

  const anchors = findAnchors(text);
  if (!anchors.length) return null;
  const values = buildSpans(text, anchors);

  const firstName = values.get("firstName")?.[0] ?? "";
  const lastName = values.get("lastName")?.[0] ?? "";
  const fullName = `${firstName} ${lastName}`.trim();
  const phoneRaw = values.get("phone")?.[0];
  const phone = phoneRaw ? normalizeFormPhone(phoneRaw) : null;
  if (!fullName || !phone) return null;

  const contact: MedicalFormContact = {
    fullName,
    phone,
    // The mailer sometimes renders an auto-linked address as "x@y.com
    // [x@y.com]" in plain text — the bracketed repeat isn't a separate value.
    email: values.get("email")?.[0]?.replace(/\s*\[.*?\]\s*$/, "").toLowerCase() ?? null,
    city: values.get("city")?.[0] ?? null,
    gender: values.get("gender")?.[0]?.toLowerCase() ?? null,
    dateOfBirth: (() => {
      const raw = values.get("dateOfBirth")?.[0];
      return raw ? parseFormDate(raw) : null;
    })(),
    fatherSpouseName: values.get("fatherSpouseName")?.[0] ?? null,
    heardAboutUs: (() => {
      const raw = values.get("heardAboutUs")?.[0];
      return raw ? stripTrailingIfClause(raw) : null;
    })(),
  };

  const health: Partial<HealthRecord> = {};
  for (const [field, fieldLines] of values) {
    if (field === "ignore" || CONTACT_FIELDS.has(field)) continue;

    if (field === "hasHealthIssues") {
      const leading = extractLeadingFlag(fieldLines.join(" "));
      if (leading) health.hasHealthIssues = leading.flag;
      continue;
    }
    if (field === "priorWellnessExperience") {
      const leading = extractLeadingFlag(fieldLines.join(" "));
      if (leading) health.priorWellnessExperience = leading.flag;
      continue;
    }
    if (field === "purposeOfVisit") {
      const { purpose, checkIn, checkOut } = splitPurposeAndDates(fieldLines);
      if (purpose.length) health.purposeOfVisit = purpose.join(", ");
      if (checkIn) health.preferredCheckIn = checkIn;
      if (checkOut) health.preferredCheckOut = checkOut;
      continue;
    }
    if (YES_NO_DETAIL_FIELDS.has(field)) {
      const leading = extractLeadingFlag(fieldLines.join(" "));
      (health as Record<string, unknown>)[field] = {
        flag: leading?.flag ?? false,
        detail: leading ? stripLeadingPrompt(leading.rest) : "",
      };
      continue;
    }
    if (field === "allergies") {
      const { options, detail } = parseAllergies(fieldLines);
      if (options.length) health.allergies = options;
      if (detail) health.allergyDetails = detail;
      continue;
    }
    if (ARRAY_FIELDS.has(field)) {
      (health as Record<string, unknown>)[field] = fieldLines;
      continue;
    }
    if (JOIN_WITH_COMMA.has(field)) {
      (health as Record<string, unknown>)[field] = fieldLines.join(", ");
      continue;
    }
    // Plain text field — wrapped lines join with a space, not a newline.
    (health as Record<string, unknown>)[field] = fieldLines.join(" ");
  }

  return { contact, health };
}

/** The two fields with no home on Guest or HealthRecord, formatted for
 *  Enquiry.intakeNotes so nothing from the form is silently dropped. */
export function formatMedicalFormNotes(contact: MedicalFormContact): string | undefined {
  const lines: string[] = [];
  if (contact.fatherSpouseName) lines.push(`Father/Spouse name: ${contact.fatherSpouseName}`);
  if (contact.heardAboutUs) lines.push(`How they heard about us: ${contact.heardAboutUs}`);
  return lines.length ? lines.join("\n") : undefined;
}
