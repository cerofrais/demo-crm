/**
 * Daily marketing CSV for the management team.
 *
 * One row per lead received on the covered day, carrying the fields management
 * asked for: identity, the lead-gen form and its answers, the campaign
 * breakdown, follow-up history, and a Hot/Warm/Cold/Dead temperature.
 *
 * WHAT IS STORED vs WHAT IS DERIVED — worth knowing before trusting a column:
 *
 *  • Stored directly: lead id, received-at, name, phone, email, city,
 *    campaign label, assigned rep, stage, lost reason.
 *  • Parsed out of `Enquiry.intakeNotes`: the form name, the ad name, and the
 *    form's question/answer pairs. The n8n Meta Lead Ads integration writes
 *    them there as "Key: value" lines (see the webhook + docs/19); there are
 *    no dedicated columns for them.
 *  • Derived from the campaign/ad naming convention: platform, ad set, and
 *    creative. Meta's own adset id is NOT captured anywhere in this system —
 *    what we have is the agency's naming scheme
 *    (CG_Trewellness_FBIG_NRI-Lead_Hyderabad-PostalCode_23June2026_Ad2_Video),
 *    so these are best-effort reads of that string, blank when it doesn't
 *    follow the convention. Capturing the real ids would need the n8n workflow
 *    to send them.
 *  • Computed from history: follow-up first/latest/count, remarks, next
 *    follow-up, temperature, and the detailed-remark signals.
 */
import { prisma } from "./prisma";
import { logger } from "./logger";
import { getObjectBuffer, putObjectBuffer } from "./storage";
import { sendEmail } from "./mailer";
import { getMailbox } from "./mailboxes";
// Lives in lib/csv.ts beside the parser; re-exported because the report
// modules and their tests have always imported it from here.
import { toCsv } from "./csv";
export { toCsv };

// ---------------------------------------------------------------------------
// intakeNotes parsing
// ---------------------------------------------------------------------------

export interface ParsedIntake {
  formName: string | null;
  adName: string | null;
  submittedAt: string | null;
  /** Everything that isn't one of the three meta lines, as "Question: answer". */
  answers: string[];
}

const META_KEYS = new Set(["ad", "form", "submitted"]);

/**
 * Splits the n8n-written intake blob into its meta lines (Ad/Form/Submitted)
 * and the actual form questions. Tolerant by design: a lead typed in by hand,
 * or from a source that doesn't follow the convention, simply yields nulls and
 * whatever free text was there as a single answer line.
 */
export function parseIntake(intakeNotes: string | null | undefined): ParsedIntake {
  const out: ParsedIntake = { formName: null, adName: null, submittedAt: null, answers: [] };
  if (!intakeNotes?.trim()) return out;

  for (const rawLine of intakeNotes.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) {
      out.answers.push(line);
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!META_KEYS.has(key)) {
      out.answers.push(line);
      continue;
    }
    if (key === "ad") out.adName = value || null;
    else if (key === "form") out.formName = value || null;
    else out.submittedAt = value || null;
  }
  return out;
}

export interface CampaignParts {
  platform: string | null;
  adset: string | null;
  creative: string | null;
}

/** Platform tokens seen in the agency's campaign naming. */
const PLATFORM_TOKENS: Record<string, string> = {
  FBIG: "Meta (Facebook / Instagram)",
  FB: "Facebook",
  IG: "Instagram",
  GOOGLE: "Google",
  GADS: "Google Ads",
  YT: "YouTube",
  LI: "LinkedIn",
};

/**
 * Best-effort read of the agency's naming convention, e.g.
 *   campaign: CG_Trewellness_FBIG_SeasonalDetox-Lead_AP&Telangna_26May2026
 *   ad:       …_26May2026_Remarket_Ad1_Video
 *
 * platform comes from the FBIG/FB/IG token; creative from the trailing
 * Ad<N>_<Format> segment; ad set from whatever sits between the campaign name
 * and that creative segment (the agency uses it for the targeting/remarket
 * split). All three are null when the string doesn't follow the convention —
 * these are a naming-scheme read, not real Meta ids.
 */
export function parseCampaignParts(
  campaignLabel: string | null | undefined,
  adName: string | null | undefined,
  fallbackSource?: string | null,
): CampaignParts {
  const out: CampaignParts = { platform: null, adset: null, creative: null };
  const haystack = `${campaignLabel ?? ""}_${adName ?? ""}`.toUpperCase();

  for (const [token, label] of Object.entries(PLATFORM_TOKENS)) {
    // Delimited match only: "FB" must not fire on a campaign containing "FBX".
    if (new RegExp(`(^|[^A-Z])${token}([^A-Z]|$)`).test(haystack)) {
      out.platform = label;
      break;
    }
  }
  // Nothing in the name — fall back to the lead source, which is always set.
  if (!out.platform && fallbackSource) {
    out.platform = fallbackSource.replace(/_/g, " ");
  }

  if (adName) {
    const creative = adName.match(/(Ad\d+(?:[_-][A-Za-z]+)?)\s*$/i);
    if (creative) out.creative = creative[1];

    // The ad name usually extends the campaign name; whatever it adds before
    // the creative segment is the agency's ad-set/targeting split.
    if (campaignLabel && adName.toUpperCase().startsWith(campaignLabel.toUpperCase())) {
      const extra = adName
        .slice(campaignLabel.length)
        .replace(/^[_-]+/, "")
        .replace(/(Ad\d+(?:[_-][A-Za-z]+)?)\s*$/i, "")
        .replace(/[_-]+$/, "");
      if (extra.trim()) out.adset = extra.trim();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lead temperature
// ---------------------------------------------------------------------------

export type LeadTemperature = "Hot" | "Warm" | "Cold" | "Dead";

/**
 * Management's definitions, verbatim:
 *   Hot  — the guest responded to our first message asking for more info, or
 *          any conversation that is going on.
 *   Warm — hasn't confirmed anything but still sounds interested / keeps the
 *          conversation going / asked us to call back / said he will call back
 *          / said he will come later.
 *   Cold — not responding at all / not interested / price too high / dropouts.
 *
 * Those are behavioural, so this reads behaviour rather than any stored field:
 * whether the guest has ever replied, how recently, and what the rep's remarks
 * say. Dead is added for a lead explicitly closed out, so "Cold" keeps meaning
 * "gone quiet" rather than being overloaded with "formally lost".
 *
 * Deliberately deterministic and keyword-based, not an LLM call — this feeds a
 * management report that has to be reproducible and explainable, and must not
 * change its answer between runs over the same data.
 */
const NEGATIVE_PATTERNS = /\b(not interested|no longer|too expensive|too high|price (is )?(too )?high|budget (issue|constraint)|cannot afford|can't afford|dropped|drop out|dropout|invalid number|wrong number|number (is )?invalid|do not (call|contact)|don't (call|contact)|unsubscribe|declined|refused)\b/i;
const WARM_PATTERNS = /\b(call ?back|callback|will call|call me|later|next month|next week|after|think about it|thinking|discuss with|check with|comparing|compare|considering|maybe|planning|plan to|revert|get back)\b/i;

/** How recently a guest reply still counts as "a conversation that is going on". */
const HOT_REPLY_WINDOW_DAYS = 7;

export interface TemperatureInput {
  stage: string;
  lostReason: string | null;
  /** Guest-originated messages only — a rep's own outbound doesn't make a lead hot. */
  inboundCount: number;
  lastInboundAt: Date | null;
  /** Rep remarks + call notes, newest first. */
  remarks: string[];
  now?: Date;
}

export function classifyTemperature(input: TemperatureInput): LeadTemperature {
  const { stage, lostReason, inboundCount, lastInboundAt, remarks } = input;
  const now = input.now ?? new Date();
  const text = [lostReason ?? "", ...remarks].join(" \n ");

  // Explicitly closed out — either lost, or already won. Both are terminal for
  // the marketing funnel and shouldn't sit in the live Hot/Warm/Cold buckets.
  // Non-leads are classified Dead alongside lost. They are not the same
  // thing — one never was a lead, the other was and did not convert — but
  // the marketing funnel has no bucket for "was never in the funnel", and
  // leaving them in Hot/Warm/Cold would inflate every live count with spam.
  if (stage === "lost" || stage === "non_leads") return "Dead";
  if (stage === "converted" || stage === "booking_confirmed" || stage === "payment_received") {
    return "Hot";
  }

  // An explicit no beats any amount of prior chat: a guest who replied twice
  // and then said "too expensive" is cold, not hot.
  if (NEGATIVE_PATTERNS.test(text)) return "Cold";

  // Never replied to anything — the definition's "not responding at all".
  if (inboundCount === 0) return "Cold";

  const daysSinceReply = lastInboundAt
    ? (now.getTime() - lastInboundAt.getTime()) / 86_400_000
    : Infinity;

  // A live conversation. Checked before the warm keywords so an active thread
  // that happens to contain "next week" stays Hot.
  if (daysSinceReply <= HOT_REPLY_WINDOW_DAYS) return "Hot";

  // Replied at some point, and either the remarks say "later/callback" or the
  // reply is simply old — interested but unconfirmed.
  if (WARM_PATTERNS.test(text) || inboundCount > 0) return "Warm";

  return "Cold";
}

// ---------------------------------------------------------------------------
// Detailed remark signals
// ---------------------------------------------------------------------------

/**
 * The vocabulary management listed for "Detailed Remarks". Each is detected
 * from the stage or from the rep's own words; several can apply at once, and
 * they're joined with "; " in the CSV. Stage-driven ones come first so the
 * strongest fact about the lead leads the cell.
 */
const REMARK_SIGNALS: { label: string; stages?: string[]; pattern?: RegExp }[] = [
  { label: "Consultation Booked", stages: ["doctor_consultation"], pattern: /\b(consultation (booked|scheduled)|doctor call (booked|scheduled))\b/i },
  { label: "Visit Completed", stages: ["converted"] },
  { label: "Admission / Booking Confirmed", stages: ["booking_confirmed", "payment_received"] },
  { label: "Ready to Visit", pattern: /\b(ready to visit|will visit|coming on|confirmed visit|visit confirmed)\b/i },
  { label: "Price Shared", stages: ["pricing_shared"] },
  { label: "Interested", stages: ["qualified"], pattern: /\b(interested|keen|wants? (to know|details|more))\b/i },
  { label: "Callback Requested", pattern: /\b(call ?back|callback|call me|will call)\b/i },
  { label: "Price Concern", pattern: /\b(too expensive|price (is )?(too )?high|budget|cost concern|discount)\b/i },
  { label: "Location Concern", pattern: /\b(too far|distance|location (issue|concern)|far from)\b/i },
  { label: "Comparing Options", pattern: /\b(comparing|compare|other (centre|center|option)|quote from)\b/i },
  { label: "Not Interested", pattern: /\b(not interested|no longer interested|declined|refused)\b/i },
  { label: "Invalid Number", pattern: /\b(invalid number|wrong number|number (is )?(invalid|not valid)|does not exist)\b/i },
  { label: "No Response", stages: ["rnr"] },
];

export function detailedRemarks(stage: string, remarkText: string, inboundCount: number): string {
  const hits: string[] = [];
  for (const sig of REMARK_SIGNALS) {
    const byStage = sig.stages?.includes(stage) ?? false;
    const byText = sig.pattern?.test(remarkText) ?? false;
    if (byStage || byText) hits.push(sig.label);
  }
  // Nothing matched and the guest never replied — say so explicitly rather
  // than leaving the cell blank, which reads as "not yet reviewed".
  if (!hits.length && inboundCount === 0) hits.push("No Response");
  return hits.join("; ");
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

export const REPORT_HEADERS = [
  "Lead ID",
  "Lead Received Date & Time",
  "Lead Name",
  "Mobile Number",
  "Email ID",
  "City/Location",
  "Form Name",
  "Form Questions & Answers",
  "Campaign Name",
  "Platform",
  "Adset / Ad Group",
  "Ad / Creative",
  "Assigned Sales Representative",
  "First Follow-up Date & Time",
  "Latest Follow-up Date & Time",
  "Number of Follow-up Attempts",
  "Latest Follow-up Remark",
  "All Follow-up Remarks",
  "Current Lead Status",
  "Detailed Remarks",
  "Next Follow-up Date",
  "Final Conversion Status",
  "Final Conversion Remarks",
];

/** Stage -> the wording management uses for the final conversion column. */
const CONVERSION_STATUS: Record<string, string> = {
  new_lead: "Open — New Lead",
  contacted: "Open — Contacted",
  rnr: "Open — No Response",
  qualified: "Open — Interested",
  pricing_shared: "Open — Pricing Shared",
  doctor_consultation: "Consultation Booked",
  payment_received: "Payment Received",
  booking_confirmed: "Admission / Booking Confirmed",
  converted: "Visit Completed",
  staff: "Open — Parked",
  lost: "Closed Lost",
};

function istDateTime(d: Date | null | undefined): string {
  if (!d) return "";
  // Asia/Kolkata throughout: the report is read by an India-based team and the
  // DB stores UTC.
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

function istDate(d: Date | null | undefined): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium" }).format(d);
}

/**
 * Builds every row for leads RECEIVED in [from, to). Scoped by createdAt, not
 * by activity, so a day's report is stable: re-running it next week returns
 * the same rows with their follow-up history brought up to date.
 */
/**
 * Tags, folded into the report's filename so a stack of downloads in
 * someone's Downloads folder stays tellable apart. Capped at three: the tag
 * vocabulary includes campaign slugs, and a six-tag filter would otherwise
 * produce a filename no mail client will show in full.
 */
export function tagFilenameSuffix(tags: string[]): string {
  if (!tags.length) return "";
  // System tags are namespaced with a colon ("source:instagram"), which
  // Windows forbids outright in a filename and macOS historically read as a
  // path separator — these get emailed to the CEO as attachments, so the
  // colon has to go rather than break the save. Anything else outside
  // [a-z0-9-] is flattened for the same reason.
  const safe = (t: string) => t.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const shown = tags.slice(0, 3).map(safe).filter(Boolean).join("_");
  if (!shown) return "";
  const rest = tags.length - 3;
  return `-${shown}${rest > 0 ? `_plus${rest}` : ""}`;
}

export async function buildReportRows(
  from: Date,
  to: Date,
  tags: string[] = [],
): Promise<(string | number | null)[][]> {
  const leads = await prisma.enquiry.findMany({
    where: {
      createdAt: { gte: from, lt: to },
      deletedAt: null,
      // OR, matching the tag filters everywhere else in the app: a lead
      // carrying any one of the selected tags is included.
      ...(tags.length ? { tags: { hasSome: tags } } : {}),
    },
    orderBy: { createdAt: "asc" },
    include: {
      guest: { select: { fullName: true, phone: true, email: true, city: true } },
      notes: { orderBy: { createdAt: "desc" }, select: { body: true, createdAt: true, authorName: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        select: { direction: true, createdAt: true, channel: true },
      },
      calls: { orderBy: { startedAt: "asc" }, select: { direction: true, startedAt: true, status: true, notes: true } },
      tasks: {
        where: { status: "open" },
        orderBy: { dueAt: "asc" },
        select: { dueAt: true, title: true },
      },
    },
  });

  return leads.map((lead) => {
    const intake = parseIntake(lead.intakeNotes);
    // 35 of the leads on this deployment have no campaignLabel but do carry a
    // Form line, and the agency names the form after the campaign — so the
    // form name is the campaign for those. Using it as the base also lets the
    // ad-set split fall out of the ad name, which needs a campaign prefix to
    // subtract.
    const campaignName = lead.campaignLabel?.trim() || intake.formName || "";
    const campaign = parseCampaignParts(campaignName, intake.adName, lead.source);

    // A follow-up ATTEMPT is us reaching out: an outbound message or an
    // outbound call. Inbound traffic is the guest's reply, not our attempt,
    // and a note is a remark about an attempt rather than one itself.
    const outboundTimes = [
      ...lead.messages.filter((m) => m.direction === "outbound").map((m) => m.createdAt),
      ...lead.calls.filter((c) => c.direction === "outbound").map((c) => c.startedAt),
    ].sort((a, b) => a.getTime() - b.getTime());

    const inbound = lead.messages.filter((m) => m.direction === "inbound");
    const lastInboundAt = inbound.length ? inbound[inbound.length - 1].createdAt : null;

    // Rep remarks: the notes timeline plus any call notes, newest first.
    const remarkEntries = [
      ...lead.notes.map((n) => ({ at: n.createdAt, text: n.body, who: n.authorName })),
      ...lead.calls.filter((c) => c.notes?.trim()).map((c) => ({ at: c.startedAt, text: c.notes!, who: "Call" })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());

    const remarkText = remarkEntries.map((r) => r.text).join(" \n ");
    const temperature = classifyTemperature({
      stage: lead.stage,
      lostReason: lead.lostReason,
      inboundCount: inbound.length,
      lastInboundAt,
      remarks: remarkEntries.map((r) => r.text),
    });

    return [
      lead.id,
      istDateTime(lead.createdAt),
      lead.guest.fullName,
      lead.guest.phone ?? "",
      lead.guest.email ?? "",
      lead.guest.city ?? "",
      intake.formName ?? "",
      intake.answers.join("\n"),
      campaignName,
      campaign.platform ?? "",
      campaign.adset ?? "",
      campaign.creative ?? "",
      lead.assignedToName ?? "Unassigned",
      istDateTime(outboundTimes[0]),
      istDateTime(outboundTimes[outboundTimes.length - 1]),
      outboundTimes.length,
      remarkEntries[0]?.text ?? "",
      remarkEntries.map((r) => `[${istDateTime(r.at)}${r.who ? ` ${r.who}` : ""}] ${r.text}`).join("\n"),
      temperature,
      detailedRemarks(lead.stage, remarkText, inbound.length),
      istDate(lead.tasks[0]?.dueAt),
      CONVERSION_STATUS[lead.stage] ?? lead.stage,
      // Final remark: the lost reason when there is one, else the latest note.
      lead.lostReason ?? remarkEntries[0]?.text ?? "",
    ];
  });
}

// ---------------------------------------------------------------------------
// Generation + delivery
// ---------------------------------------------------------------------------

/** Start-of-day in IST, expressed as the UTC instant to query with. */
export function istDayBounds(day: Date): { from: Date; to: Date } {
  // IST is a fixed +05:30 with no DST, so a constant offset is exact here.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istMidnight = new Date(Math.floor((day.getTime() + IST_OFFSET_MS) / 86_400_000) * 86_400_000);
  const from = new Date(istMidnight.getTime() - IST_OFFSET_MS);
  return { from, to: new Date(from.getTime() + 86_400_000) };
}

export function ceoEmail(): string {
  return process.env.MARKETING_REPORT_TO ?? "ceo@trewellness.in";
}

/**
 * Builds (or rebuilds) the report for one day and stores it. Idempotent per
 * day: re-running replaces that day's file and row, so a manual "generate now"
 * after the scheduled run refreshes the numbers rather than creating a second
 * report for the same date.
 */
export async function generateMarketingReport(
  day: Date,
  tags: string[] = [],
): Promise<{ id: string; rowCount: number }> {
  const { from, to } = istDayBounds(day);
  const dateLabel = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(from);
  const suffix = tagFilenameSuffix(tags);
  return storeReport({
    from,
    to,
    tags,
    filename: `marketing-leads-${dateLabel}${suffix}.csv`,
    // The DAY the report covers — its unique key, so a re-run replaces the
    // file rather than adding a second report for the same date.
    //
    // A TAGGED report is a filtered subset, not "the report for that day", so
    // it must never claim that slot: doing so would overwrite the full
    // report the scheduled run produces and emails to the CEO, replacing it
    // with whatever narrow slice someone happened to pull. Tagged runs are
    // therefore stored as custom reports, keyed on the generation instant.
    reportDate: tags.length ? null : new Date(`${dateLabel}T00:00:00.000Z`),
    keyPrefix: dateLabel,
    rangeStart: from,
    rangeEnd: new Date(to.getTime() - 1),
  });
}

/**
 * Ad-hoc report over an arbitrary window, for the manual generator on the
 * Marketing page — "give me last week", or one specific day months back.
 *
 * `to` is treated as INCLUSIVE of that whole IST day: a user picking
 * 1 Aug – 3 Aug means three days of leads, not two and a half. Stored under a
 * synthetic reportDate so it can't collide with (or overwrite) a scheduled
 * daily report — those own the real calendar dates.
 */
export async function generateRangeReport(
  fromDay: Date,
  toDay: Date,
  tags: string[] = [],
): Promise<{ id: string; rowCount: number }> {
  const { from } = istDayBounds(fromDay);
  const { to } = istDayBounds(toDay);
  if (to <= from) throw new Error("The end date must be on or after the start date");

  const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
  const startLabel = fmt(from);
  // `to` is the exclusive end (midnight after the last day) — step back inside
  // it so the filename shows the last day actually covered.
  const endLabel = fmt(new Date(to.getTime() - 1));
  const single = startLabel === endLabel;

  const suffix = tagFilenameSuffix(tags);
  return storeReport({
    from,
    to,
    tags,
    filename: single
      ? `marketing-leads-${startLabel}${suffix}.csv`
      : `marketing-leads-${startLabel}_to_${endLabel}${suffix}.csv`,
    // A custom range is not "the report for a calendar day", so it must not
    // take that day's unique slot. Null reportDate would need a nullable
    // unique; instead the range gets its own row keyed on the generation
    // instant, which no daily report will ever collide with.
    reportDate: null,
    keyPrefix: single ? startLabel : `${startLabel}_to_${endLabel}`,
    rangeStart: from,
    rangeEnd: new Date(to.getTime() - 1),
  });
}

async function storeReport(opts: {
  from: Date;
  to: Date;
  filename: string;
  reportDate: Date | null;
  keyPrefix: string;
  rangeStart?: Date;
  rangeEnd?: Date;
  tags?: string[];
}): Promise<{ id: string; rowCount: number }> {
  const rows = await buildReportRows(opts.from, opts.to, opts.tags ?? []);
  const buffer = Buffer.from(toCsv(REPORT_HEADERS, rows), "utf8");

  // Generation instant in the key so a regenerated custom range never
  // overwrites the object an earlier download link still points at.
  const unique = opts.reportDate ? "" : `-${Date.now()}`;
  const storageKey = `reports/marketing/${opts.keyPrefix}/${opts.filename.replace(/\.csv$/, "")}${unique}.csv`;
  await putObjectBuffer(storageKey, buffer, "text/csv");

  const data = {
    filename: opts.filename,
    storageKey,
    rowCount: rows.length,
    sizeBytes: buffer.byteLength,
    rangeStart: opts.rangeStart ?? opts.from,
    rangeEnd: opts.rangeEnd ?? new Date(opts.to.getTime() - 1),
  };

  const saved = opts.reportDate
    ? await prisma.marketingReport.upsert({
        where: { reportDate: opts.reportDate },
        create: { reportDate: opts.reportDate, ...data },
        update: { ...data, generatedAt: new Date(), emailedAt: null, emailedTo: null, emailError: null },
      })
    : await prisma.marketingReport.create({ data });

  logger.info(
    { filename: opts.filename, rowCount: rows.length, custom: !opts.reportDate, tags: opts.tags ?? [] },
    "marketing report generated",
  );
  return { id: saved.id, rowCount: rows.length };
}

/** Emails a stored report as a CSV attachment. Records success or failure on
 *  the row so the page can show whether the CEO actually received it. */
export async function emailMarketingReport(
  reportId: string,
  to = ceoEmail(),
): Promise<{ to: string; rowCount: number }> {
  const report = await prisma.marketingReport.findUnique({ where: { id: reportId } });
  if (!report) throw new Error("Report not found");

  const buffer = await getObjectBuffer(report.storageKey);

  // Sent from the shared sales mailbox — the same identity guests already see,
  // and the one guaranteed to be configured in a working deployment.
  const mailbox = getMailbox("sales");
  if (!mailbox?.configured) {
    throw new Error("The sales mailbox isn't configured — can't email the marketing report");
  }
  // Custom ranges have no single reportDate — describe the window instead.
  const fullDate = (d: Date) =>
    new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "full" }).format(d);
  const sameDay = fullDate(report.rangeStart) === fullDate(report.rangeEnd);
  const dateLabel = sameDay
    ? fullDate(report.rangeStart)
    : `${fullDate(report.rangeStart)} – ${fullDate(report.rangeEnd)}`;

  try {
    await sendEmail(mailbox, {
      // Internal artefact for the CEO, not correspondence with a guest — a
      // marketing signature on a CSV of leads would just be noise.
      skipFooter: true,
      to,
      subject: `Trē Wellness — daily marketing lead report, ${dateLabel}`,
      text: [
        `Daily marketing lead report for ${dateLabel}.`,
        "",
        `${report.rowCount} lead${report.rowCount === 1 ? "" : "s"} received.`,
        "",
        "The attached CSV lists each lead with its campaign breakdown, follow-up history and current status.",
        "Column definitions are on the Reports > Marketing page in the CRM.",
      ].join("\n"),
      attachments: [{ filename: report.filename, content: buffer, contentType: "text/csv" }],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "send failed";
    await prisma.marketingReport.update({
      where: { id: reportId },
      data: { emailError: message },
    });
    throw err;
  }

  await prisma.marketingReport.update({
    where: { id: reportId },
    data: { emailedAt: new Date(), emailedTo: to, emailError: null },
  });
  logger.info({ reportId, to, rowCount: report.rowCount }, "marketing report emailed");
  return { to, rowCount: report.rowCount };
}

/**
 * The scheduled job: build yesterday's report and send it. Yesterday, not
 * today, because it runs in the morning and a report for a day still in
 * progress would be incomplete the moment it landed.
 */
export async function runDailyMarketingReport(): Promise<void> {
  const yesterday = new Date(Date.now() - 86_400_000);
  const { id } = await generateMarketingReport(yesterday);
  await emailMarketingReport(id).catch((err) =>
    logger.error({ err, id }, "marketing report: scheduled email failed"),
  );
}

/** IST hour-of-day the scheduled run fires at. */
export function reportHourIst(): number {
  const raw = Number(process.env.MARKETING_REPORT_HOUR_IST ?? 7);
  return Number.isFinite(raw) && raw >= 0 && raw <= 23 ? raw : 7;
}

/**
 * Ticked frequently by the server process; does the work only once per IST
 * day, at or after the configured hour.
 *
 * The guard is the MarketingReport row itself rather than an in-memory flag —
 * a restart, a redeploy, or a second app instance would each re-fire a
 * timer-only schedule, and the CEO would get the same report several times.
 * Since the row is unique per reportDate, "yesterday already has a report that
 * has been emailed" is the authoritative "already done".
 */
export async function tickDailyMarketingReport(): Promise<void> {
  // Everything is inside the try, including the schedule arithmetic and the
  // "already done?" lookup. The caller invokes this as `void tick()`, so
  // anything thrown outside a catch becomes an unhandled rejection that
  // disappears without a log line — which is exactly how the first deploy of
  // this scheduler failed silently.
  try {
    const nowIstHour = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        hour12: false,
      }).format(new Date()),
    );
    if (!Number.isFinite(nowIstHour) || nowIstHour < reportHourIst()) return;

    const yesterday = new Date(Date.now() - 86_400_000);
    const { from } = istDayBounds(yesterday);
    const dateLabel = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(from);
    const reportDate = new Date(`${dateLabel}T00:00:00.000Z`);

    const existing = await prisma.marketingReport.findUnique({ where: { reportDate } });
    if (existing?.emailedAt) return; // already generated AND delivered today

    if (!existing) await generateMarketingReport(yesterday);
    const row = await prisma.marketingReport.findUnique({ where: { reportDate } });
    if (row && !row.emailedAt) await emailMarketingReport(row.id);
  } catch (err) {
    // Logged, not rethrown: the next tick retries, and emailMarketingReport
    // has already recorded any send failure on the row for the page to show.
    logger.error({ err }, "marketing report: scheduled run failed");
  }
}
