import { ageFromDob } from "./utils";

/**
 * Lead tagging — shared (client + server), no DB / node deps.
 *
 * Two kinds of tags live in one flat list on each enquiry:
 *  • SYSTEM tags  — derived from data and re-computed on every save:
 *      age group  →  "age:<25" | "age:25-40" | "age:40-60" | "age:60+"
 *      revisit    →  "revisit"
 *      source     →  "source:facebook" | "source:website_form" | …
 *  • CUSTOM tags  — free-form slugs added by staff (e.g. "high-intent").
 *
 * System tags use a "category:" prefix so we can recompute them without
 * clobbering custom tags. The UI renders friendly labels via formatTag().
 */

export type TagCategory = "blocked" | "age" | "revisit" | "source" | "campaign" | "foreign" | "custom";

const SYSTEM_PREFIXES = ["age:", "source:", "campaign:"];

// "blocked" is Guest-only (set via block/unblock, see tags-service.ts) —
// listed here alongside the Enquiry system tags since isSystemTag/formatTag/
// sortTags are shared between both. Never editable through the free-text
// tag input either way.
export function isSystemTag(value: string): boolean {
  return (
    value === "revisit" ||
    value === "foreign" ||
    value === "blocked" ||
    SYSTEM_PREFIXES.some((p) => value.startsWith(p))
  );
}

export function tagCategory(value: string): TagCategory {
  if (value === "blocked") return "blocked";
  if (value === "revisit") return "revisit";
  if (value === "foreign") return "foreign";
  if (value.startsWith("age:")) return "age";
  if (value.startsWith("source:")) return "source";
  if (value.startsWith("campaign:")) return "campaign";
  return "custom";
}

/**
 * The package a guest asked about on the enquiry form ("Package Preference:
 * Mini Detox" → "mini-detox").
 *
 * A PLAIN custom slug, deliberately un-namespaced. Staff had already been
 * tagging leads "mini-detox" / "wellness-experience" / "major-detox" by hand
 * long before this was automated, so minting a parallel "package:mini-detox"
 * put two identically-labelled chips in the tag picker for the same thing.
 * Using the slug staff already use means the automation and a human land on
 * one shared tag, which is also what makes filtering by it work.
 */
export function packageTag(preference: string): string | null {
  return slugifyTag(preference) || null;
}

/** Normalise a user-entered custom tag into a safe slug. */
export function slugifyTag(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function ageBucket(age: number | null): string | null {
  if (age == null) return null;
  if (age < 25) return "age:<25";
  if (age < 40) return "age:25-40";
  if (age < 60) return "age:40-60";
  return "age:60+";
}

interface GuestLike {
  dateOfBirth?: Date | string | null;
  isReturning?: boolean;
  phone?: string | null;
}
interface EnquiryLike {
  source?: string | null;
  isReturningFlag?: boolean;
  campaignLabel?: string | null;
}

/** The system tags a lead should currently have. */
export function computeSystemTags(guest: GuestLike, enquiry: EnquiryLike): string[] {
  const out: string[] = [];
  const age = ageBucket(ageFromDob(guest.dateOfBirth ?? null));
  if (age) out.push(age);
  if (guest.isReturning || enquiry.isReturningFlag) out.push("revisit");
  if (enquiry.source) out.push(`source:${enquiry.source}`);
  if (enquiry.campaignLabel) {
    const slug = slugifyTag(enquiry.campaignLabel);
    if (slug) out.push(`campaign:${slug}`);
  }
  // Has a phone number, and it isn't Indian — a no-phone lead (email-only)
  // isn't "foreign", it's just unknown, so this only fires when there's a
  // number to actually judge.
  if (guest.phone && !guest.phone.startsWith("+91")) out.push("foreign");
  return out;
}

/**
 * Merge persisted tags with freshly computed system tags:
 * keep all CUSTOM tags, drop stale system tags, add current system tags.
 * System tags come first for stable, readable ordering.
 */
export function mergeLeadTags(
  persisted: string[] | undefined,
  guest: GuestLike,
  enquiry: EnquiryLike,
): string[] {
  const custom = (persisted ?? []).filter((t) => !isSystemTag(t));
  const system = computeSystemTags(guest, enquiry);
  return Array.from(new Set([...system, ...custom]));
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------
const SOURCE_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  website_form: "Website",
  referral: "Referral",
  walk_in: "Walk-in",
  phone: "Phone",
  whatsapp: "WhatsApp",
  google_sheets: "Google Sheets",
  other: "Other",
};

const AGE_LABELS: Record<string, string> = {
  "<25": "Under 25",
  "25-40": "25–40",
  "40-60": "40–60",
  "60+": "60+",
};

export interface FormattedTag {
  value: string;
  label: string;
  category: TagCategory;
  className: string;
}

const CATEGORY_CLASS: Record<TagCategory, string> = {
  blocked: "bg-red-600 text-white",
  age: "bg-amber-100 text-amber-800",
  revisit: "bg-brand-100 text-brand-700",
  source: "bg-sky-100 text-sky-700",
  campaign: "bg-indigo-100 text-indigo-800",
  foreign: "bg-rose-100 text-rose-700",
  custom: "bg-violet-100 text-violet-700",
};

/** "high-intent" / a campaign slug -> "High Intent" */
function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function formatTag(value: string): FormattedTag {
  const category = tagCategory(value);
  let label = value;
  if (category === "blocked") label = "Blocked";
  else if (category === "age") label = AGE_LABELS[value.slice(4)] ?? value.slice(4);
  else if (category === "revisit") label = "Revisit";
  else if (category === "foreign") label = "Foreign";
  else if (category === "source") {
    const s = value.slice(7);
    label = SOURCE_LABELS[s] ?? s;
  } else if (category === "campaign") {
    label = titleCaseSlug(value.slice(9));
  } else {
    label = titleCaseSlug(value);
  }
  return { value, label, category, className: CATEGORY_CLASS[category] };
}

/** Sort tags for display: blocked first (most important to notice), then
 *  age → revisit → source → campaign → custom, alpha within.
 *  Every category must appear here — indexOf returns -1 for a missing one,
 *  which would silently sort it ahead of "blocked". */
export function sortTags(values: string[]): string[] {
  const order: TagCategory[] = ["blocked", "age", "revisit", "foreign", "source", "campaign", "custom"];
  return [...values].sort((a, b) => {
    const d = order.indexOf(tagCategory(a)) - order.indexOf(tagCategory(b));
    return d !== 0 ? d : a.localeCompare(b);
  });
}
