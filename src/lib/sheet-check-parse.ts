/**
 * Lead sheet check — the pure half: reading Meta lead-ad rows out of a sheet,
 * deciding which rows to check, whether each is already in the CRM, and the
 * payload a missing one is pushed with. No I/O, so every rule here is tested.
 *
 * WHAT THE SHEETS LOOK LIKE (checked against the live ones)
 * Meta's export columns — id, created_time, ad/adset/campaign/form, is_organic,
 * platform, the form's own questions, full_name, phone_number, email, [city],
 * lead_status — followed by columns staff type into by hand. The header row
 * isn't reliably row 1: on two sheets row 1 is a lead and the header is row 2,
 * on another it's row 3. Phones carry Meta's "p:" prefix.
 */

export interface SheetLead {
  /** 1-based row number in the sheet. */
  rowNumber: number;
  /** Meta's lead id ("l:1380107277554505") — the de-duplication key n8n uses. */
  metaId: string | null;
  createdTime: string | null;
  createdAt: Date | null;
  fullName: string;
  phone: string;
  email: string | null;
  city: string | null;
  platform: string | null;
  campaignName: string | null;
  adsetName: string | null;
  adName: string | null;
  formName: string | null;
  isOrganic: boolean;
  answers: { question: string; answer: string }[];
}

export interface ParseResult {
  leads: SheetLead[];
  headerRow: number | null;
  skipped: { rowNumber: number; reason: string }[];
}

const META_PHONE = /^p:\s*\+?\d/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
// Rows a human marked as not-a-lead, plus Meta's seeded dummy row — the same
// list the n8n workflow skips.
const NON_LEAD = /test lead:?\s*dummy data|its a test case|no need to call|do not call/i;

const norm = (h: string) => h.trim().toLowerCase().replace(/\s+/g, "_");
const clean = (v: string | undefined) => (v ?? "").trim();

/** Digits a phone is matched on: the last ten, which ignores +91 vs 0 vs none. */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function looksLikePhone(v: string): boolean {
  return META_PHONE.test(v.trim()) || /^\+?[\d\s()-]{10,}$/.test(v.trim());
}

const stripPrefix = (v: string) => v.trim().replace(/^p:\s*/i, "");

function humanizeQuestion(h: string): string {
  const t = h.replace(/^_+|_+$/g, "").replace(/_+/g, " ").replace(/\s*\?\s*$/, "").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : h;
}

/** Finds the header row: the first of the top ten carrying a phone column name. */
function findHeader(values: string[][]): number {
  for (let i = 0; i < Math.min(values.length, 10); i++) {
    const cells = values[i].map(norm);
    if (cells.includes("phone_number") || (cells.includes("phone") && cells.includes("full_name"))) return i;
  }
  return -1;
}

export function parseLeadRows(values: string[][]): ParseResult {
  const headerIdx = findHeader(values);
  const header = headerIdx >= 0 ? values[headerIdx].map(norm) : null;
  const col = (name: string) => (header ? header.indexOf(name) : -1);

  const idx = header
    ? {
        id: col("id"),
        created: col("created_time"),
        ad: col("ad_name"),
        adset: col("adset_name"),
        campaign: col("campaign_name"),
        form: col("form_name"),
        organic: col("is_organic"),
        platform: col("platform"),
        name: col("full_name") >= 0 ? col("full_name") : col("name"),
        phone: col("phone_number") >= 0 ? col("phone_number") : col("phone"),
        email: col("email"),
        city: col("city"),
      }
    : null;

  // Questions sit between Meta's fixed columns and full_name.
  const questionCols: number[] = [];
  if (header && idx && idx.name > 0) {
    const start = Math.max(idx.platform, idx.organic, idx.form, idx.campaign, idx.created) + 1;
    for (let c = start; c < idx.name; c++) if (header[c]) questionCols.push(c);
  }

  const leads: SheetLead[] = [];
  const skipped: ParseResult["skipped"] = [];

  values.forEach((cells, i) => {
    const rowNumber = i + 1;
    if (i === headerIdx) return;
    if (!cells.some((c) => c.trim())) return;
    if (NON_LEAD.test(cells.join(" "))) {
      skipped.push({ rowNumber, reason: "marked as a test / do-not-call row" });
      return;
    }

    // Header mapping first; if that cell isn't a phone (a shifted row, or a
    // sheet without a header), anchor on Meta's "p:" phone cell instead.
    let phoneCol = idx && idx.phone >= 0 && looksLikePhone(clean(cells[idx.phone])) ? idx.phone : -1;
    const anchored = phoneCol === -1;
    if (anchored) phoneCol = cells.findIndex((c) => META_PHONE.test(c.trim()));
    if (phoneCol === -1) {
      skipped.push({ rowNumber, reason: "no phone number" });
      return;
    }

    const at = (c: number) => (c >= 0 ? clean(cells[c]) : "");
    const fullName = anchored ? at(phoneCol - 1) : at(idx!.name);
    const emailCell = anchored ? at(phoneCol + 1) : at(idx!.email);
    const createdTime = (!anchored && idx!.created >= 0 && ISO_TIME.test(at(idx!.created)) ? at(idx!.created) : cells.find((c) => ISO_TIME.test(c.trim()))?.trim()) || null;
    const createdAt = createdTime && !Number.isNaN(Date.parse(createdTime)) ? new Date(createdTime) : null;
    const metaId = (!anchored && idx!.id >= 0 && at(idx!.id)) || cells.find((c) => /^l:\d+$/.test(c.trim()))?.trim() || null;
    const platformCell = !anchored && idx!.platform >= 0 ? at(idx!.platform) : cells.map((c) => c.trim().toLowerCase()).find((c) => c === "ig" || c === "fb") ?? "";

    leads.push({
      rowNumber,
      metaId,
      createdTime,
      createdAt,
      fullName: fullName || "Unknown",
      phone: stripPrefix(cells[phoneCol]),
      email: emailCell.includes("@") ? emailCell : null,
      city: (anchored ? at(phoneCol + 2) : at(idx!.city)) || null,
      platform: platformCell ? platformCell.toLowerCase() : null,
      campaignName: (!anchored && at(idx!.campaign)) || null,
      adsetName: (!anchored && at(idx!.adset)) || null,
      adName: (!anchored && at(idx!.ad)) || null,
      formName: (!anchored && at(idx!.form)) || null,
      isOrganic: !anchored && at(idx!.organic).toLowerCase() === "true",
      answers: anchored
        ? []
        : questionCols
            .map((c) => ({ question: humanizeQuestion(values[headerIdx][c]), answer: at(c) }))
            .filter((a) => a.answer),
    });
  });

  return { leads, headerRow: headerIdx >= 0 ? headerIdx + 1 : null, skipped };
}

// ---------------------------------------------------------------------------
// Which rows to check
// ---------------------------------------------------------------------------

export const LAST_N = 10;
/** n8n checks every 5 minutes; a row newer than this may simply not have been
 *  picked up yet, and pushing it would race the workflow. Checked next time. */
export const GRACE_MS = 60 * 60 * 1000;
/** Re-check rows dated up to a day before the previous check, so a row
 *  inserted mid-sheet or sorted into place is still covered. */
const OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * The last ten rows, plus everything added since the previous check — by row
 * number (appended rows) or by date (rows sorted or inserted). The first ever
 * check has no previous one, so it looks at the last ten only rather than
 * reporting the sheet's whole history.
 */
export function selectLeadsToCheck(
  leads: SheetLead[],
  previous: { lastRowNumber: number | null; lastCheckedAt: Date | null } | null,
  now: Date,
): { toCheck: SheetLead[]; tooRecent: SheetLead[] } {
  const picked = new Map<number, SheetLead>();
  for (const l of leads.slice(-LAST_N)) picked.set(l.rowNumber, l);
  if (previous?.lastRowNumber != null || previous?.lastCheckedAt) {
    const since = previous.lastCheckedAt ? previous.lastCheckedAt.getTime() - OVERLAP_MS : null;
    for (const l of leads) {
      const newRow = previous.lastRowNumber != null && l.rowNumber > previous.lastRowNumber;
      const newDate = since !== null && l.createdAt !== null && l.createdAt.getTime() >= since;
      if (newRow || newDate) picked.set(l.rowNumber, l);
    }
  }
  const all = [...picked.values()].sort((a, b) => a.rowNumber - b.rowNumber);
  const cutoff = now.getTime() - GRACE_MS;
  return {
    toCheck: all.filter((l) => !l.createdAt || l.createdAt.getTime() <= cutoff),
    tooRecent: all.filter((l) => l.createdAt && l.createdAt.getTime() > cutoff),
  };
}

// ---------------------------------------------------------------------------
// Is it in the CRM?
// ---------------------------------------------------------------------------

export interface CrmIndex {
  externalRefs: Set<string>;
  phoneKeys: Set<string>;
  emails: Set<string>;
}

/**
 * In the CRM when its Meta lead id was already ingested, or a guest has its
 * phone or email — the webhook folds a known guest into their existing
 * record, so "a guest with this phone exists" is what arriving looks like.
 */
export function isInCrm(lead: SheetLead, crm: CrmIndex): boolean {
  if (lead.metaId && crm.externalRefs.has(lead.metaId)) return true;
  const key = phoneKey(lead.phone);
  if (key && crm.phoneKeys.has(key)) return true;
  return !!lead.email && crm.emails.has(lead.email.toLowerCase());
}

// ---------------------------------------------------------------------------
// The payload a missing lead is pushed with — parity with n8n's Build + Sign
// ---------------------------------------------------------------------------

/** The four campaign labels the CRM tags by, matched from Meta's names. */
export function canonicalCampaign(l: Pick<SheetLead, "campaignName" | "adsetName" | "adName" | "formName">): string | null {
  const hay = [l.campaignName, l.adsetName, l.adName, l.formName].map((x) => x ?? "").join(" ").toLowerCase();
  if (/nri/.test(hay)) return "NRI Lead Campaign";
  if (/generic\s*wellness/.test(hay)) return "Generic Wellness Campaign";
  if (/seasonal\s*detox|seasonaldetox|summer\s*detox|summerdetox/.test(hay)) {
    if (/telangna|telangana|ap&|_ap_|-ap-/.test(hay)) return "Seasonal Detox Campaign AP/TEL";
    if (/hyderabad|\bhyd\b/.test(hay)) return "Seasonal Detox Campaign HYD";
  }
  return null;
}

const INTEREST_TAGS: Record<string, string> = {
  "stress_relief_&_relaxation": "Stress Relief Relaxation",
  _reduce_stress: "Stress Relief Relaxation",
  "stress_&_fatigue": "Stress Relief Relaxation",
  "fitness_&_physical_health": "Fitness Physical Health",
  "mental_clarity_&_focus": "Mental Clarity Focus",
  "energy_&_vitality_boost": "Energy Vitality Boost",
  improve_energy_levels: "Energy Vitality Boost",
  detox_my_body: "Detox",
  lose_weight_: "Weightloss",
  weight_gain: "Weightloss",
  "lifestyle-related_conditions": "Lifestyle Conditions",
  digestive_issues: "Digestive Health",
};

export function interestTag(answers: SheetLead["answers"]): string | undefined {
  const pick = ["most interested in", "primary health goal", "biggest health challenge"]
    .map((k) => answers.find((a) => a.question.toLowerCase().includes(k)))
    .find(Boolean);
  return pick ? INTEREST_TAGS[pick.answer.trim().toLowerCase()] : undefined;
}

export interface PushPayload {
  fullName: string;
  phone: string;
  email?: string;
  city?: string;
  source: "instagram" | "facebook" | "other";
  campaignLabel?: string;
  packagePreference?: string;
  intakeNotes?: string;
}

export function buildPushPayload(lead: SheetLead, sheetCampaignLabel: string | null): { payload: PushPayload; externalRef: string } {
  const source = lead.platform === "ig" ? "instagram" : lead.platform === "fb" || lead.metaId ? "facebook" : "other";
  const campaignLabel =
    sheetCampaignLabel?.trim() || canonicalCampaign(lead) || lead.campaignName || lead.adsetName || lead.adName || undefined;
  const notes = [
    ...lead.answers.map((a) => `${a.question}: ${a.answer}`),
    ...(lead.adName ? [`Ad: ${lead.adName}`] : []),
    ...(lead.formName ? [`Form: ${lead.formName}`] : []),
    ...(lead.isOrganic ? ["Organic (no ad spend)"] : []),
    ...(lead.createdTime ? [`Submitted: ${lead.createdTime}`] : []),
    `Added by the lead sheet check — sheet row ${lead.rowNumber} hadn't reached the CRM`,
  ];
  return {
    payload: {
      fullName: lead.fullName,
      phone: lead.phone,
      ...(lead.email ? { email: lead.email } : {}),
      ...(lead.city ? { city: lead.city } : {}),
      source,
      ...(campaignLabel ? { campaignLabel } : {}),
      ...(interestTag(lead.answers) ? { packagePreference: interestTag(lead.answers) } : {}),
      intakeNotes: notes.join("\n"),
    },
    // Same key n8n sends, so whichever of the two gets there second is
    // recognised as the same lead rather than opening a second card.
    externalRef: lead.metaId || `phone:${lead.phone}`,
  };
}

/** Whether a scheduled tick is due, given the last real run. */
export function isDue(lastRunStartedAt: Date | null, intervalDays: number, now: Date): boolean {
  if (!lastRunStartedAt) return true;
  // Two hours' slack so a run that started a little late doesn't push the
  // next one a whole day back (the cron only calls in once a day).
  return now.getTime() - lastRunStartedAt.getTime() >= intervalDays * 86_400_000 - 2 * 3_600_000;
}
