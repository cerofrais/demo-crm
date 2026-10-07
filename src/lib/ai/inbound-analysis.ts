/**
 * What are guests actually asking us?
 *
 * Groups genuine inbound guest messages into recurring question topics, counts
 * them, and cross-references each topic against the message templates that
 * already exist — so it's visible which questions reps answer from scratch
 * every time, and therefore which templates are worth writing.
 *
 * The grouping is deterministic keyword matching, NOT an LLM pass. Three
 * reasons: it's free and instant over thousands of messages, the same corpus
 * always yields the same numbers (so a week-on-week comparison means
 * something), and the topics are a fixed vocabulary the business already
 * thinks in. The LLM is used only for the optional step of DRAFTING a template
 * once a gap has been identified — see suggestTemplate().
 */
import { prisma } from "../prisma";
import { cleanMessageBody } from "../message-display";
import { chatJSON } from "./provider";
import { logAiDecision } from "./audit";
import { DATA_FENCE_RULES, fence, llmString, llmStringArray, parseLlm } from "./safety";
import { z } from "zod";

export interface TopicDef {
  key: string;
  label: string;
  /** What a rep is being asked, in the business's own words. */
  description: string;
  patterns: RegExp[];
  /** Words that identify an existing template as already covering this. */
  templateHints: string[];
}

/**
 * The question taxonomy. Ordered most-specific first: a message matching
 * several topics is counted under all of them (guests routinely ask two things
 * in one line — "what's the price and where are you located"), but the order
 * decides which one leads in the UI.
 */
export const TOPICS: TopicDef[] = [
  {
    key: "pricing",
    label: "Pricing & cost",
    description: "What does it cost, per day or per package, and what's included in that number.",
    patterns: [
      // Plurals matter: \bprice\b does NOT match "prices", and 31 messages in
      // the corpus say "prices" — they were all landing in unrecognised.
      /\b(prices?|pricing|costs?|charges?|rates?|fees?|how much|per day|per night|package costs?|tariffs?|quotations?|quotes?)\b/i,
      /\b(gst|discounts?|offers?|cheaper|budget|expensive)\b/i,
      /₹|\brs\.?\s*\d|\blakhs?\b/i,
      // NB: a bare 5-7 digit number was tried as a "quoted amount" signal and
      // removed — on the real corpus it matched 153 messages, almost all
      // postcodes ("Hyderabad 500034") and phone fragments rather than prices.
    ],
    templateHints: ["pricing", "price", "cost", "offer"],
  },
  {
    key: "programme",
    label: "Programme & package details",
    description: "What the programme actually involves — inclusions, highlights, what a day looks like.",
    // Deliberately NOT a bare /details?|info/: those words appear in most
    // long messages and made this topic match 70% of the corpus. Requires an
    // actual request for material, or a programme-specific noun.
    patterns: [
      /\b(brochure|itinerary|highlights?|inclusions?|what('?s| is) included|package details?)\b/i,
      /\b(send|share|forward|provide|mail)\b[^.?!]{0,40}\b(details?|info(rmation)?|brochure|pdf|programme|program|packages?)\b/i,
      /\b(more|further)\b[^.?!]{0,20}\b(details?|info(rmation)?)\b/i,
    ],
    templateHints: ["intro", "general", "programme", "program", "package", "highlights"],
  },
  {
    key: "therapies",
    label: "Therapies & medical",
    description: "Treatments offered, doctor consultation, and whether a condition can be treated.",
    // Named treatments and conditions only. "doctor" and "consultation" alone
    // were pulling in every booking conversation.
    patterns: [
      /\b(therapy|therapies|treatment|naturopathy|ayurved\w*|panchakarma|shirodhara|abhyanga|massage|physio\w*|acupuncture)\b/i,
      /\b(doctor consultation|medical condition|diagnos\w+|diabet\w+|thyroid|arthrit\w+|pcod|pcos|weight loss|detox programme|detox program)\b/i,
    ],
    templateHints: ["therapy", "therapies", "treatment", "doctor", "detox"],
  },
  {
    key: "duration",
    label: "Duration & stay length",
    description: "How many days are needed, and minimum or recommended stay.",
    patterns: [
      /\b(how many days|how long|duration|minimum stay|number of days|\d+\s*(day|night|week)s?\b)/i,
    ],
    templateHints: ["duration", "days", "stay"],
  },
  {
    key: "availability",
    label: "Availability & dates",
    description: "Whether specific dates are free, and when the guest can come.",
    // Bare "available" matched anything; availability questions in this corpus
    // always pair it with a date, a slot or a booking word.
    patterns: [
      /\b(availability|any (slot|date)s?|slots? (free|open|available)|vacan\w+)\b/i,
      /\b(available)\b[^.?!]{0,30}\b(date|day|month|week|weekend|from|on|for)\b/i,
      /\b(date|dates)\b[^.?!]{0,25}\b(available|free|open|possible|suit)\w*/i,
      /\b(check|confirm)\b[^.?!]{0,20}\bdates?\b/i,
    ],
    templateHints: ["availability", "dates", "booking"],
  },
  {
    key: "booking_payment",
    label: "Booking & payment",
    description: "How to book, advance amount, payment methods, refunds and cancellation.",
    patterns: [
      /\b(book(ing)?|reserve|reservation|confirm(ation)?|advance|deposit|pay(ment|ed)?|paid|upi|bank|transfer|refund|cancel\w*|invoice|receipt)\b/i,
    ],
    templateHints: ["booking", "process", "payment", "advance"],
  },
  {
    key: "accommodation",
    label: "Accommodation & occupancy",
    description: "Room types, single vs double occupancy, and who can accompany the guest.",
    patterns: [
      /\b(room|accommodation|occupancy|single|double|twin|suite|cottage|villa|stay with|accompany\w*|attendant|couple)\b/i,
    ],
    templateHints: ["accommodation", "room", "occupancy"],
  },
  {
    key: "location",
    label: "Location & travel",
    description: "Where the retreat is, how to reach it, and airport pickup.",
    // City names alone are dropped — they appear in signatures, addresses and
    // campaign labels far more often than in an actual "where are you" question.
    patterns: [
      /\b(location|where (is|are|exactly)|address|how (to|do i|can i) reach|directions?|distance|airport|pick ?up|drop off|far (from|is)|nearest)\b/i,
    ],
    templateHints: ["location", "address", "reach", "travel"],
  },
  {
    key: "food",
    label: "Food & diet",
    description: "Meals provided, dietary restrictions and whether food is included.",
    patterns: [/\b(food|meal|diet|breakfast|lunch|dinner|vegetarian|vegan|jain|satvik|sattvic|cuisine|kitchen)\b/i],
    templateHints: ["food", "diet", "meal"],
  },
  {
    key: "membership",
    label: "Membership & vouchers",
    description: "Gift vouchers, memberships, validity and corporate tie-ups.",
    patterns: [/\b(membership|member|voucher|gift card|gift voucher|validity|valid till|expire\w*|corporate|tie ?up|commission)\b/i],
    templateHints: ["membership", "voucher", "gift"],
  },
  {
    key: "callback",
    label: "Callback & contact requests",
    description: "Asking us to call, or naming a time to be reached — no product question attached.",
    patterns: [
      /\b(call me|please call|can you call|give me a call|call back|callback|ring me|reach me|available (at|after|before)|talk to)\b/i,
      /\b(call (me )?(tomorrow|today|now|at|before|after))\b/i,
    ],
    templateHints: ["call back", "callback", "when to call"],
  },
  {
    key: "facilities",
    label: "Facilities & amenities",
    description: "Gym, pool, wifi, library and what else is on site.",
    patterns: [/\b(gym|swimming|pool|wifi|wi-fi|library|indoor games|outdoor games|spa|sauna|steam|facilit\w+|amenit\w+)\b/i],
    templateHints: ["facilit", "amenit"],
  },
];

/**
 * Noise that isn't a guest question: our own system-generated message labels
 * (see describeNonMediaMessage in lib/whatsapp.ts), bare acknowledgements, and
 * contact-detail fragments. Counting these would inflate every topic and bury
 * the real signal.
 */
const NOISE_PATTERNS: RegExp[] = [
  /^\s*(📷|🖼️|📍|👤|📊|🛒|📋|🎥|📄)/u,
  /^\s*\[(unsupported|encrypted|interactive|media|template)/i,
  /^\s*(reacted|removed a reaction)\b/i,
  /^\s*(ok(ay)?|k|yes|yeah|ya|no|nope|thanks?|thank you|ty|sure|hi|hello|hey|good (morning|afternoon|evening)|welcome|great|nice|done|noted|fine|hmm+)\s*[.!]*\s*$/i,
  /^\s*\+?\d[\d\s\-()]{6,}\s*$/, // a bare phone number
  /^\s*\S+@\S+\.\S+\s*$/, // a bare email address
  // Automated mail that reaches a shared inbox: security alerts, delivery
  // failures, newsletters. Not a guest asking anything, and it was matching
  // topics on incidental words.
  /\b(new sign-?in|security alert|verify your (email|account)|password reset|do ?not ?reply|no-?reply@|unsubscribe|delivery (has )?failed|undeliverable|mailer-daemon|out of office|automatic reply)\b/i,
];

/**
 * Staff talking to staff on a business number, stored as inbound because it
 * arrived from an outside handset. Not a guest question, and it was polluting
 * the "unrecognised" bucket badly enough to hide real blind spots. Conservative
 * on purpose — anchored on CRM/ops vocabulary a guest has no reason to use.
 */
const INTERNAL_PATTERNS: RegExp[] = [
  /\bcrm\b/i,
  /\b(lead|leads)\b[^.?!]{0,30}\b(today|added|assign\w*|upload\w*|sheet)\b/i,
  /\b(follow ?up|call(ed)?)\b[^.?!]{0,25}\b(her|him|them|guest|client)\b/i,
  /\bnot responding\b/i,
  /\b(sir|madam|mam)\b[^.?!]{0,20}\b(link|login|password|access|report|sheet)\b/i,
];

export function isInternalChatter(body: string): boolean {
  return INTERNAL_PATTERNS.some((p) => p.test(body));
}

/**
 * A structured form submission rather than a question — the website enquiry
 * form and the health intake form both arrive by email as a long list of
 * "Label: value" lines.
 *
 * These dominated the corpus before being excluded: they run to a median of
 * ~10,000 characters and list every therapy and package on offer, so a single
 * submission matched half the taxonomy and made "Therapies" look like the most
 * asked-about topic in the business. They're captured as leads elsewhere; they
 * are not somebody asking us something.
 *
 * Detected structurally (many labelled lines) rather than by matching the
 * current form's field names, so a new or reworded form is caught too.
 */
export function isFormSubmission(body: string): boolean {
  // Labelled pairs anywhere, not just line-anchored — the website form arrives
  // both as one line per field and as a single wrapped paragraph.
  const labelled = (body.match(/[A-Za-z][\w /&()'-]{2,40}[ \t]*:[ \t]*\S/g) ?? []).length;
  if (labelled >= 6) return true;

  // The health intake form uses no colons at all ("First Name Shanthi Last
  // Name Krishna Age 52 Date of Birth ..."), so it needs its field names.
  const HEALTH_FIELDS = [
    /\bfirst name\b/i,
    /\blast name\b/i,
    /\bdate of birth\b/i,
    /\bblood group\b/i,
    /\bemergency contact\b/i,
    /\bmarital status\b/i,
    /\bfather\/spouse\b/i,
    /\bheight \(in\b/i,
    /\bweight \(in\b/i,
  ];
  return HEALTH_FIELDS.filter((p) => p.test(body)).length >= 3;
}

export function isNoise(body: string): boolean {
  const t = body.trim();
  if (t.length < 8) return true; // too short to carry a question
  return NOISE_PATTERNS.some((p) => p.test(t));
}

/** Every topic a message touches. Empty when nothing matched. */
export function classifyMessage(body: string): string[] {
  return TOPICS.filter((t) => t.patterns.some((p) => p.test(body))).map((t) => t.key);
}

/**
 * The single topic a message is mainly about — the first match in TOPICS
 * order, which is arranged most-specific first.
 *
 * Needed because a long message legitimately touches several topics, so raw
 * match counts sum well past the message count and the shares become
 * uninterpretable ("70% programme, 67% therapies"). The UI leads with primary
 * shares, which sum to 100, and keeps the mention counts alongside as the
 * "also came up in" number.
 */
export function primaryTopic(body: string): string | null {
  return TOPICS.find((t) => t.patterns.some((p) => p.test(body)))?.key ?? null;
}

/**
 * How much of each example message to send.
 *
 * Was 300, which cut most messages mid-sentence and left nothing for the UI to
 * expand to — "show full message" had no full message to show. Long enough now
 * to carry a real enquiry end to end; the genuinely long inbound bodies are
 * form submissions, and those are excluded before this point.
 */
const EXAMPLE_CHARS = 4000;

export interface TopicStat {
  key: string;
  label: string;
  description: string;
  /** Messages whose MAIN subject is this topic. Sums to the classified total. */
  primaryCount: number;
  /** Share of classified messages by primary topic, 0-100 — these sum to 100. */
  primaryShare: number;
  /** Messages mentioning this topic at all, including alongside others. */
  count: number;
  /** Share by mention, 0-100. Sums past 100 by design. */
  share: number;
  /** Verbatim guest messages, longest first — the useful ones for writing a reply. */
  examples: string[];
  /** Templates that already look like they answer this, one entry per NAME
   *  with its channels listed — the library holds the same template for both
   *  email and WhatsApp, which otherwise renders as a duplicate. */
  existingTemplates: { name: string; channels: string[] }[];
  /** True when nothing in the library covers this topic. */
  gap: boolean;
}

export interface InboundAnalysis {
  from: string;
  to: string;
  totalInbound: number;
  analysed: number;
  noise: number;
  /** Staff-to-staff messages excluded from the topic analysis. */
  internal: number;
  /** Website/health form submissions excluded — long, structured, not questions. */
  forms: number;
  /** Analysed guest messages per channel — both WhatsApp and email are included. */
  byChannel: Record<string, number>;
  unmatched: number;
  unmatchedExamples: string[];
  topics: TopicStat[];
}

/**
 * Aggregates inbound guest messages over a window. Outbound is excluded
 * entirely — this is about what guests ask, not what we say.
 */
export async function analyseInbound(from: Date, to: Date): Promise<InboundAnalysis> {
  const messages = await prisma.message.findMany({
    where: { direction: "inbound", createdAt: { gte: from, lt: to } },
    select: { body: true, channel: true },
    orderBy: { createdAt: "desc" },
    // Generous but bounded: the whole corpus is a few thousand, and this keeps
    // one bad date range from pulling everything into memory.
    take: 20_000,
  });

  const templates = await prisma.messageTemplate.findMany({
    // A retired template is not something to suggest staff send.
    where: { archivedAt: null },
    select: { id: true, name: true, channel: true, body: true },
  });

  const counts = new Map<string, { count: number; primary: number; examples: string[] }>();
  for (const t of TOPICS) counts.set(t.key, { count: 0, primary: 0, examples: [] });

  const byChannel: Record<string, number> = {};
  let noise = 0;
  let internal = 0;
  let forms = 0;
  let unmatched = 0;
  const unmatchedExamples: string[] = [];

  for (const m of messages) {
    const body = m.body.trim();
    if (isNoise(body)) {
      noise++;
      continue;
    }
    // Staff ops chatter on a business number — excluded before classification
    // so it can't inflate a topic or bury a real blind spot in "unrecognised".
    if (isInternalChatter(body)) {
      internal++;
      continue;
    }
    if (isFormSubmission(body)) {
      forms++;
      continue;
    }
    byChannel[m.channel] = (byChannel[m.channel] ?? 0) + 1;
    const hits = classifyMessage(body);
    if (!hits.length) {
      unmatched++;
      // Kept so the taxonomy's blind spots are visible rather than silently
      // rolled into "other".
      if (unmatchedExamples.length < 25 && body.length > 25) {
        unmatchedExamples.push(cleanMessageBody(body).clean.slice(0, EXAMPLE_CHARS));
      }
      continue;
    }
    const main = hits[0];
    for (const key of hits) {
      const bucket = counts.get(key)!;
      bucket.count++;
      if (key === main) bucket.primary++;
      // Examples come from the messages this topic actually leads, so they
      // read as questions about it rather than passing mentions.
      // Cleaned here, not just at render time: these examples are also what
      // gets sent to the model when drafting a template, and a 280-character
      // tracking pixel in the prompt is pure noise and wasted tokens.
      if (key === main && bucket.examples.length < 200) {
        bucket.examples.push(cleanMessageBody(body).clean.slice(0, EXAMPLE_CHARS));
      }
    }
  }

  const analysed = messages.length - noise - internal - forms;
  const classified = analysed - unmatched;

  const topics: TopicStat[] = TOPICS.map((t) => {
    const bucket = counts.get(t.key)!;
    // Matched on NAME first. Bodies are long and mention half the business,
    // so body-matching alone attributed most templates to most topics; it is
    // kept only as a fallback for a template whose name says nothing useful
    // (e.g. "General Intro").
    const matched = templates.filter((tpl) => {
      const byName = t.templateHints.some((h) => tpl.name.toLowerCase().includes(h));
      if (byName) return true;
      const nameIsGeneric = /^(general|intro|introductory)/i.test(tpl.name.trim());
      return nameIsGeneric && t.templateHints.some((h) => tpl.body.toLowerCase().includes(h));
    });

    // Collapse the email/WhatsApp pair of the same template into one entry.
    const byName = new Map<string, Set<string>>();
    for (const tpl of matched) {
      if (!byName.has(tpl.name)) byName.set(tpl.name, new Set());
      byName.get(tpl.name)!.add(tpl.channel);
    }
    const existingTemplates = [...byName.entries()]
      .map(([name, channels]) => ({ name, channels: [...channels].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      key: t.key,
      label: t.label,
      description: t.description,
      primaryCount: bucket.primary,
      primaryShare: classified ? Math.round((bucket.primary / classified) * 1000) / 10 : 0,
      count: bucket.count,
      share: classified ? Math.round((bucket.count / classified) * 1000) / 10 : 0,
      // Longest first: a two-word message rarely helps someone draft an answer.
      examples: [...bucket.examples].sort((a, b) => b.length - a.length).slice(0, 8),
      existingTemplates,
      gap: existingTemplates.length === 0,
    };
  })
    .filter((t) => t.count > 0)
    .sort((a, b) => b.primaryCount - a.primaryCount || b.count - a.count);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totalInbound: messages.length,
    analysed,
    noise,
    internal,
    forms,
    byChannel,
    unmatched,
    unmatchedExamples,
    topics,
  };
}

// ---------------------------------------------------------------------------
// Template drafting (the only LLM step)
// ---------------------------------------------------------------------------

const suggestionSchema = z.object({
  name: llmString(80),
  body: llmString(2000),
  rationale: llmString(600),
  coversQuestions: llmStringArray(6, 160),
});

export type TemplateSuggestion = z.infer<typeof suggestionSchema>;

const SYSTEM = `You write WhatsApp reply templates for the sales team at Trē Wellness, an Ayurvedic and naturopathy wellness retreat near Hyderabad, India.

You are given a topic that guests ask about repeatedly, and real examples of how they ask it. Write ONE reusable template a rep can send with minimal editing.

Rules for the template body:
- Warm and professional, in Indian-English business register. Short paragraphs or bullets; WhatsApp, not a brochure.
- Use {name} where the guest's first name goes and {salutation} for Mr./Ms. — these are substituted automatically.
- NEVER invent specific prices, dates, package names, durations or medical claims. Where a concrete figure belongs, write a clearly-marked placeholder such as [price per day] or [available dates] for the rep to fill in.
- Answer the question the examples actually ask. Do not pad with unrelated marketing.
- End with one natural next step (a question back, or an offer to call).
${DATA_FENCE_RULES}`;

/**
 * Drafts a template for one topic from the real questions guests asked.
 * Audited as an AiDecision like every other model call in this system, so the
 * prompt and output are reviewable on this same page.
 */
export async function suggestTemplate(
  topicKey: string,
  examples: string[],
  triggeredBy?: string,
  triggeredByName?: string,
): Promise<TemplateSuggestion> {
  const topic = TOPICS.find((t) => t.key === topicKey);
  if (!topic) throw new Error(`Unknown topic ${topicKey}`);

  const userPrompt = [
    `TOPIC: ${topic.label}`,
    `WHAT GUESTS WANT: ${topic.description}`,
    "",
    "REAL GUEST MESSAGES ON THIS TOPIC (verbatim, untrusted):",
    // Guest-written text — fence it so nothing inside can be read as an
    // instruction to the model.
    ...examples.slice(0, 25).map((e) => fence("GUEST_MESSAGE", e)),
    "",
    `Return JSON: {"name": string, "body": string, "rationale": string, "coversQuestions": string[]}`,
    `"name" is a short template name for the library. "rationale" explains in one or two sentences why this wording suits these questions. "coversQuestions" lists the specific guest questions this answers.`,
  ].join("\n");

  const t0 = Date.now();
  let result: TemplateSuggestion;
  try {
    result = parseLlm(suggestionSchema, await chatJSON<unknown>(SYSTEM, userPrompt, { maxTokens: 1500 }));
  } catch (err) {
    await logAiDecision({
      kind: "template_suggestion",
      promptSystem: SYSTEM,
      promptUser: userPrompt,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
      triggeredBy,
      triggeredByName,
    });
    throw err;
  }

  await logAiDecision({
    kind: "template_suggestion",
    promptSystem: SYSTEM,
    promptUser: userPrompt,
    output: result,
    success: true,
    durationMs: Date.now() - t0,
    triggeredBy,
    triggeredByName,
  });
  return result;
}
