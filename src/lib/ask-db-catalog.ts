/**
 * The schema the model is shown — hand-written, not generated.
 *
 * prisma/schema.prisma has 42 models and thousands of words of commentary; an
 * 8B model given all of it writes worse SQL than one given the twenty tables
 * people actually ask about, with the handful of facts that are impossible to
 * guess from column names: that timestamps are UTC while the office works in
 * IST, that a deleted lead is a row with deletedAt set, that the WhatsApp line
 * a message went out on lives in Message.fromEmail, and that staff say "the 61
 * number" rather than +918712623061.
 *
 * It is documentation, not a security boundary — ask-db-guard.ts decides what
 * may actually be read, and its allowlist is the thing to change if a table
 * should become reachable. Every table named here must appear there too;
 * ask-db-catalog.test.ts holds the two in step.
 */
interface TableDoc {
  name: string;
  what: string;
  columns: string;
}

const TABLES: TableDoc[] = [
  {
    name: "Enquiry",
    what: "one lead card on the pipeline board. THE table for anything about leads.",
    columns:
      'id, "guestId", stage, source, "assignedToName", "assignedToSub", "campaignLabel", tags text[], "lostReason", "quotedPriceINR", "stayDays", "roomCount", "pricePerDayINR", "preferredCheckIn", "aiScore", "needsAttention", "externalRef", "intakeNotes", "lastActivityAt", "createdAt", "updatedAt", "lostAt", "deletedAt", "packageId", "doctorDecision"',
  },
  {
    name: "Guest",
    what: "the person behind one or more leads; one row per phone number.",
    columns:
      'id, "fullName", phone, email, city, gender, "dateOfBirth", tags text[], "isReturning", "isBlocked", "consentGiven", "aiReturnScore", "aiNextProgram", "createdAt", "deletedAt"',
  },
  {
    name: "Message",
    what: "every WhatsApp, email and SMS, in both directions.",
    columns:
      'id, "guestId", "enquiryId", channel, direction, subject, body, "fromEmail", "toEmail", status, "templateId", "broadcastJobId", "attachmentNames" text[], transcript, "transcriptEnglish", "transcribedAt", "needsReview", "createdAt", "deletedAt"',
  },
  {
    name: "Call",
    what: "phone calls through Plivo, with recording and AI analysis.",
    columns:
      'id, "guestId", "enquiryId", direction, status, "repName", "repPhone", "customerPhone", "startedAt", "answeredAt", "endedAt", "durationSec", "recordingUrl", tags text[], notes, transcript, "transcriptEnglish", "aiSummary", "aiScore", "aiTags" text[], "aiAnalyzedAt", "createdAt"',
  },
  {
    name: "Activity",
    what: "the audit trail: who did what to which lead.",
    columns:
      'id, "enquiryId", "guestId", "actorSub", "actorName", "actorRole", "actionType" (stage_change | note | message_sent | task_created | task_completed | doc_upload | assign | created | consent), metadata jsonb, "createdAt"',
  },
  { name: "Note", what: "remarks a rep typed on a lead.", columns: 'id, "enquiryId", "authorSub", "authorName", "authorRole", body, "createdAt"' },
  { name: "Task", what: "follow-ups on a lead.", columns: 'id, "enquiryId", title, "dueAt", status (open|done|cancelled), kind (follow_up|doctor_review|deletion_approval|payment_pending), "assignedToSub", "createdBy", "createdAt"' },
  { name: "Tag", what: "the tag vocabulary. Tags actually ON a lead are Enquiry.tags.", columns: "id, value, category, \"createdAt\"" },
  { name: "Package", what: "programmes that can be sold.", columns: 'id, name, category, "durationDays", "basePriceINR", "isActive"' },
  { name: "Membership", what: "memberships a guest holds.", columns: 'id, "guestId", "planName", "startDate", "expiryDate", "creditsTotal", "creditsUsed", status' },
  { name: "ReferralCode", what: "referral codes.", columns: "id, code, \"createdAt\"" },
  {
    name: "BroadcastJob",
    what: "a bulk WhatsApp campaign. Its individual messages are Message rows with that broadcastJobId.",
    columns:
      'id, status, "createdBySub", message, "templateName", "numberId", "guestIds" text[], "totalCount", "sentCount", "failedCount", "scheduledAt", "createdAt", "completedAt", "deletedAt"',
  },
  { name: "MessageTemplate", what: "saved WhatsApp/email templates.", columns: "id, name, channel, body, \"createdAt\"" },
  {
    name: "SheetCheckRun",
    what: "each run of the Google Sheets lead check — how many sheet rows were checked and how many were missing from the CRM.",
    columns: 'id, trigger, "dryRun", status, "checkedCount", "missingCount", "pushedCount", "pushFailedCount", summary jsonb, "startedAt", "finishedAt"',
  },
  { name: "SheetCheckSource", what: "the Google Sheets being watched.", columns: 'id, name, "sheetUrl", "campaignLabel", enabled, "lastRowNumber", "lastCheckedAt", "lastStatus"' },
  { name: "CresentReport", what: "weekly Cresent report runs.", columns: 'id, "weekStart", "rangeEnd", tags text[], "rowCount", "emailedAt", "createdAt"' },
  { name: "MarketingReport", what: "marketing report runs.", columns: "id" },
  { name: "AiDecision", what: "every AI inference: kind, model, output, success.", columns: 'id, kind, "enquiryId", "callId", "guestId", provider, model, output jsonb, success, "durationMs", "triggeredByName", "createdAt"' },
  { name: "StaffProfile", what: "staff directory.", columns: "id, sub, name, email" },
  { name: "StaffShift", what: "staff shift windows.", columns: "id, sub" },
  { name: "StaffLeave", what: "staff leave.", columns: "id, sub" },
];

const ENUMS = `stage (EnquiryStage): new_lead, contacted, rnr, qualified, pricing_shared, doctor_consultation, payment_received, booking_confirmed, converted, staff, non_leads, lost
source (LeadSource): website_form, whatsapp, instagram, facebook, referral, walk_in, phone, email, other
  ('google_sheets' is also a valid value of this enum, but NOT ONE ROW in the database has it. Never put source = 'google_sheets' in a query — it always returns zero. Leads from the Google Sheets are instagram/facebook rows with an "externalRef", as the rule below says.)
Message.channel: whatsapp, email, sms   Message.direction / Call.direction: inbound, outbound
Call.status: initiated, ringing, connected, completed, no_answer, failed, voicemail`;

const RULES = `HOW THIS DATABASE WORKS
- PostgreSQL. Tables and columns are quoted PascalCase/camelCase: "Enquiry", "createdAt". ALWAYS quote them; unquoted names are folded to lower case and will not be found.
- Every timestamp is stored in UTC. The office works in IST: write ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') when a date is grouped or displayed. For "last N days" just use "createdAt" >= now() - interval 'N days'.
- Soft deletes: a row with "deletedAt" IS NOT NULL is deleted and should be excluded unless the question asks about deleted ones. ONLY these four tables have a "deletedAt" column: "Enquiry", "Guest", "Message", "BroadcastJob". "Call", "Activity", "Note", "Task" and every other table have NO "deletedAt" — using it there is an error.
- A lead is an "Enquiry". A person is a "Guest". One Guest can have several Enquiries. Join on "Enquiry"."guestId" = "Guest".id.
- WhatsApp lines are phone numbers, and staff name them by the last two digits. On an OUTBOUND WhatsApp Message, "fromEmail" holds the number it was sent from:
    "the 61 number" = '+918712623061' (Cloud API)
    "the 60 number" = '+918712623060'
    "the 52 number" = '+918977766852'
  So messages sent from 61 = "Message" WHERE channel = 'whatsapp' AND direction = 'outbound' AND "fromEmail" = '+918712623061'.
- Leads from the Meta lead ads — the ones that land in the Google Sheets and are pushed in from there — are "Enquiry" rows with source 'instagram' or 'facebook' AND "externalRef" IS NOT NULL ("externalRef" is the Meta lead id, which only those rows carry). Their campaign is "campaignLabel". The enum value 'google_sheets' exists but is not used in practice, so do NOT filter on it; use the instagram/facebook + "externalRef" test instead. How the sheet CHECK itself performed is "SheetCheckRun".
- Voice notes are Message rows with a transcript; call recordings are "Call"."recordingUrl".
- Counting people vs leads: count(*) counts leads; count(DISTINCT "guestId") counts people.
- TAGS LIVE IN TWO PLACES AND IT MATTERS. A tag staff put on someone — 'detox', 'mini-detox', 'high-intent', 'nri' — is on "Enquiry".tags. "Guest".tags holds machine-written ones: the WhatsApp lines they have talked on ('wa:918712623061'), 'failed', 'blocked', and the broadcast audience lists ('camp-pre-midaug-a-to-c'). So "guests with the tag detox" means: join "Enquiry" and filter "Enquiry".tags — filtering "Guest".tags for it matches nobody. Test membership with 'detox' = ANY(e.tags).
- "Sent a message" means direction = 'outbound' (from us). "They replied" or "heard back" means direction = 'inbound' (from the guest). Getting these the wrong way round answers the opposite question and usually returns zero rows, so read the question twice.

RULES FOR THE SQL YOU WRITE
- One single SELECT statement. No INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, GRANT or any other write — the connection is read-only and will refuse them.
- Only these tables exist for you. Health records, documents and WhatsApp credentials are not readable.
- Prefer an aggregate when the question asks "how many". Return the columns a person would want to read, not "SELECT *", and give computed columns a readable alias.
- Order by the most useful column, usually a date descending.
- Never invent a column. If a question cannot be answered with these tables, say so in "explanation" and return an empty "sql".
- Every query has a FROM clause naming one of the tables above. A SELECT with no FROM is always wrong.

WORKED EXAMPLES — follow these patterns closely.

Q: how many new leads came in from the google sheets last week?
A: SELECT count(*) AS leads FROM "Enquiry" WHERE source IN ('instagram', 'facebook') AND "externalRef" IS NOT NULL AND "deletedAt" IS NULL AND "createdAt" >= now() - interval '7 days'

Q: what are all the messages sent from the 61 number in the last 10 days?
A: SELECT m."createdAt", g."fullName", m."toEmail", m.body, m.status FROM "Message" m LEFT JOIN "Guest" g ON g.id = m."guestId" WHERE m.channel = 'whatsapp' AND m.direction = 'outbound' AND m."fromEmail" = '+918712623061' AND m."deletedAt" IS NULL AND m."createdAt" >= now() - interval '10 days' ORDER BY m."createdAt" DESC

Q: how many whatsapp messages did we send each day this month?
A: SELECT ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date AS day, count(*) AS sent FROM "Message" WHERE channel = 'whatsapp' AND direction = 'outbound' AND "deletedAt" IS NULL AND "createdAt" >= date_trunc('month', now()) GROUP BY day ORDER BY day DESC`;

/** The schema block handed to the model, ~1.5k tokens. */
export function schemaPrompt(): string {
  const tables = TABLES.map((t) => `"${t.name}" — ${t.what}\n    ${t.columns}`).join("\n");
  return `TABLES YOU MAY READ\n${tables}\n\nENUM VALUES\n${ENUMS}\n\n${RULES}`;
}

/** Example questions shown on the page, and useful few-shot material. */
export const SAMPLE_QUESTIONS = [
  "What are all the messages sent from the 61 number in the last 10 days?",
  "How many new leads came in from the google sheets last week?",
  "How many leads did each rep convert this month?",
  "Which leads are in payment received but have no call in the last 7 days?",
  "Show the calls longer than 5 minutes this week with their AI summary",
  "How many WhatsApp messages did we send each day this month?",
];

/**
 * The tables a question may read. The guard enforces this; the catalogue owns
 * it so the two can never describe different sets — a table documented here
 * but missing from the guard would produce SQL that is always refused, and one
 * in the guard but not here would be invisible to the model.
 */
export const ALLOWED_TABLES = TABLES.map((t) => t.name);

/**
 * Every camelCase column named above, by its lower-cased form.
 *
 * Postgres folds an unquoted identifier to lower case, so a model that writes
 * `a.actorName` instead of `a."actorName"` asks for a column that does not
 * exist — the single most common mistake an 8B model makes against a Prisma
 * schema, and one Postgres itself answers with "perhaps you meant". The guard
 * uses this map to put the quotes back rather than spending a retry on it.
 */
export const KNOWN_COLUMNS: ReadonlyMap<string, string> = new Map(
  TABLES.flatMap((t) => [...t.columns.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) => [m[1].toLowerCase(), m[1]] as const)),
);
