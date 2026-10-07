"use client";

/**
 * Seed data for the features merged from main in September 2026 — the demo
 * counterpart of their database tables. Everything here is shaped exactly as
 * the real API returns it, so ext-routes.ts can hand it straight back.
 *
 * Also adds the per-lead detail those features read (booking details,
 * attachment names, an archived template, payment chases) to the base seed.
 */
import { emptyHealthRecord, type HealthRecord } from "../health";
import type { DemoData, DemoUser } from "./types";

type Strategy = "round_robin" | "least_busy";

export interface DemoEmailAutoReply {
  id: string;
  mailboxId: string;
  subjectTerms: string[];
  bodyTerms: string[];
  termMatch: "any" | "all";
  subject: string | null;
  replyText: string;
  attachmentDocumentIds: string[];
  attachments: { id: string; filename: string; mimeType: string; sizeBytes: number }[];
  tagOnMatch: string | null;
  enabled: boolean;
  activeFromMin: number | null;
  activeToMin: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DemoEmailAutoTag {
  id: string;
  mailboxId: string;
  subjectTerms: string[];
  bodyTerms: string[];
  termMatch: "any" | "all";
  tag: string;
  enabled: boolean;
  createdAt: string;
}

export interface DemoWaAutoTag {
  id: string;
  numberId: string;
  trigger: string;
  tag: string;
  enabled: boolean;
  createdAt: string;
}

export interface DemoHealthRecordRow {
  id: string;
  guestId: string;
  subjectName: string | null;
  hasDuplicate: boolean;
  updatedAt: string;
  record: HealthRecord;
}

export interface DemoSheetSource {
  id: string;
  name: string;
  sheetUrl: string;
  campaignLabel: string | null;
  enabled: boolean;
  lastRowNumber: number | null;
  lastCheckedAt: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
}

export interface DemoSheetSummary {
  sourceId: string;
  name: string;
  tab: string | null;
  leadsInSheet: number;
  checked: number;
  heldBack: number;
  missing: number;
  pushed: number;
  pushFailed: number;
  error: string | null;
}

export interface DemoSheetRun {
  id: string;
  trigger: "schedule" | "manual";
  dryRun: boolean;
  status: "ok" | "issues" | "failed";
  checkedCount: number;
  missingCount: number;
  pushedCount: number;
  pushFailedCount: number;
  sheetErrors: number;
  summary: DemoSheetSummary[];
  hasCsv: boolean;
  emailedAt: string | null;
  emailedTo: string | null;
  emailError: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface DemoCresentSend {
  id: string;
  weekStart: string;
  rangeEnd: string;
  scheduled: boolean;
  tags: string[];
  rowCount: number;
  emailedAt: string | null;
  emailedTo: string | null;
  emailError: string | null;
  createdAt: string;
}

export interface DemoExt {
  /** State for the features merged from main in October 2026 (ext-oct.ts).
   *  Optional and built on first use, so a payload seeded before October
   *  keeps working instead of being thrown away. */
  oct?: {
    folders: { id: string; channel: "email" | "whatsapp"; name: string; parentId: string | null }[];
    scheduledTags: { id: string; numberId: string; tag: string; label: string | null; startsAt: string; endsAt: string; enabled: boolean }[];
    asked: { id: string; question: string; at: string; ok: boolean; mode: "sql" | "lead" | null; by: string | null; bySub: string | null; sql: string | null; answer: unknown }[];
  };

  emailFooter: { enabled: boolean; html: string; text: string; updatedAt: string | null };
  emailAutoReplies: DemoEmailAutoReply[];
  emailAutoTags: DemoEmailAutoTag[];
  waAutoTags: DemoWaAutoTag[];
  welcomeEmail: {
    enabled: boolean;
    subject: string;
    body: string;
    activeFromMin: number | null;
    activeToMin: number | null;
    attachmentDocumentId: string | null;
    attachment: null;
    fromAddress: string | null;
  };
  tagRules: { tag: string; label: string; strategy: Strategy; eligibleSubs: string[]; priority: number }[];
  numberRules: { ourNumber: string; label: string; strategy: Strategy; eligibleSubs: string[] }[];
  availability: Record<string, {
    weeklyOffDays: number[];
    shifts: { weekday: number; start: string; end: string }[];
    leave: { id: string; startDate: string; endDate: string; note: string | null }[];
  }>;
  /** Staff pinned to specific WhatsApp lines (E.164); absent = every line. */
  userLines: Record<string, string[]>;
  healthRecords: DemoHealthRecordRow[];
  cresent: {
    settings: { enabled: boolean; recipients: string[]; tags: string[]; updatedAt: string | null };
    sends: DemoCresentSend[];
  };
  sheetCheck: {
    settings: { enabled: boolean; intervalDays: number; recipients: string[]; pushMissing: boolean; lastTickAt: string | null };
    sources: DemoSheetSource[];
    runs: DemoSheetRun[];
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const istDay = (msAgo: number) => new Date(Date.now() - msAgo + 5.5 * HOUR).toISOString().slice(0, 10);
const monday = (weeksAgo: number) => {
  const ist = new Date(Date.now() + 5.5 * HOUR);
  const since = (ist.getUTCDay() + 6) % 7;
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - since - 7 * weeksAgo));
  return d.toISOString().slice(0, 10);
};
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY).toISOString().slice(0, 10);

function healthRecord(fill: Partial<HealthRecord>): HealthRecord {
  return { ...emptyHealthRecord(), ...fill };
}

function buildExt(db: DemoData, users: DemoUser[]): DemoExt {
  const sub = (role: string) => users.find((u) => u.role === role)?.sub ?? users[0]!.sub;
  const cloud = db.whatsappNumbers.find((n) => n.integration === "cloud_api") ?? db.whatsappNumbers[0];
  const lines = db.whatsappNumbers.filter((n) => n.phoneNumber);

  // Two guests share a phone for the family case: a parent's form and a
  // child's form under one number, plus a near-duplicate resubmission.
  const [g1, g2, g3] = db.guests;
  const healthRecords: DemoHealthRecordRow[] = [];
  if (g1) {
    healthRecords.push(
      { id: "hr-1", guestId: g1.id, subjectName: g1.fullName, hasDuplicate: true, updatedAt: iso(5 * DAY),
        record: healthRecord({ heightCm: "168", weightKg: "74", bloodGroup: "B+", hasHealthIssues: true, healthIssues: "Type 2 diabetes, well controlled", medications: "Metformin 500mg" }) },
      { id: "hr-2", guestId: g1.id, subjectName: g1.fullName, hasDuplicate: true, updatedAt: iso(2 * DAY),
        record: healthRecord({ heightCm: "168", weightKg: "73", bloodGroup: "B+", hasHealthIssues: true, healthIssues: "Type 2 diabetes", medications: "Metformin 500mg, Vitamin D" }) },
      { id: "hr-3", guestId: g1.id, subjectName: `${g1.fullName.split(" ")[0]}'s daughter`, hasDuplicate: false, updatedAt: iso(2 * DAY),
        record: healthRecord({ heightCm: "152", weightKg: "44", bloodGroup: "O+", allergies: ["Peanuts"], allergyDetails: "Mild — antihistamine on hand" }) },
    );
  }
  if (g2) healthRecords.push({ id: "hr-4", guestId: g2.id, subjectName: g2.fullName, hasDuplicate: false, updatedAt: iso(9 * DAY),
    record: healthRecord({ heightCm: "175", weightKg: "82", bloodGroup: "A+", hasHealthIssues: true, healthIssues: "Lower back pain" }) });
  if (g3) healthRecords.push({ id: "hr-5", guestId: g3.id, subjectName: g3.fullName, hasDuplicate: false, updatedAt: iso(15 * DAY),
    record: healthRecord({ heightCm: "160", weightKg: "58", bloodGroup: "AB+" }) });

  // Campaign tags that actually exist on seeded leads, so the weekly client
  // report has something to show from the first click.
  const campaignTags = [...new Set(db.enquiries.map((e) => e.campaignLabel).filter(Boolean) as string[])]
    .slice(0, 3)
    .map((l) => `campaign:${l.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32)}`);

  const weekday = [1, 2, 3, 4, 5, 6];
  const shift = (start: string, end: string) => weekday.map((w) => ({ weekday: w, start, end }));

  return {
    emailFooter: {
      enabled: true,
      html: "<p><strong>Meridian Wellness</strong> — an integrative wellness retreat<br>www.meridianwellness.demo · +91 80000 12345</p>",
      text: "Meridian Wellness — an integrative wellness retreat\nwww.meridianwellness.demo · +91 80000 12345",
      updatedAt: iso(6 * DAY),
    },
    emailAutoReplies: [
      { id: "ear-1", mailboxId: "sales", subjectTerms: [], bodyTerms: ["meridianwellness.demo/experience-packages"], termMatch: "any",
        subject: "Your sample itinerary — Experience Packages", replyText: "<p>Dear {name},</p><p>Thank you for your interest. Your sample itinerary is attached.</p>",
        attachmentDocumentIds: [], attachments: [{ id: "doc-itin-ep", filename: "Sample Itinerary - Experience Packages.pdf", mimeType: "application/pdf", sizeBytes: 125_919 }],
        tagOnMatch: "sample-itinerary-ep", enabled: true, activeFromMin: null, activeToMin: null, createdAt: iso(8 * DAY), updatedAt: iso(8 * DAY) },
      { id: "ear-2", mailboxId: "sales", subjectTerms: ["brochure", "price list"], bodyTerms: [], termMatch: "any",
        subject: null, replyText: "<p>Thanks for writing in — our brochure is attached. A member of the team will follow up shortly.</p>",
        attachmentDocumentIds: [], attachments: [{ id: "doc-brochure", filename: "Meridian Brochure 2026.pdf", mimeType: "application/pdf", sizeBytes: 842_110 }],
        tagOnMatch: null, enabled: true, activeFromMin: null, activeToMin: null, createdAt: iso(12 * DAY), updatedAt: iso(12 * DAY) },
    ],
    emailAutoTags: [
      { id: "eat-1", mailboxId: "sales", subjectTerms: ["price", "cost"], bodyTerms: [], termMatch: "any", tag: "price-asked", enabled: true, createdAt: iso(4 * DAY) },
      { id: "eat-2", mailboxId: "sales", subjectTerms: [], bodyTerms: ["couple", "my wife", "my husband"], termMatch: "any", tag: "double-occupancy", enabled: true, createdAt: iso(4 * DAY) },
      { id: "eat-3", mailboxId: "doctor", subjectTerms: [], bodyTerms: ["diabetes", "blood pressure"], termMatch: "any", tag: "medical-query", enabled: true, createdAt: iso(3 * DAY) },
    ],
    waAutoTags: cloud
      ? [
          { id: "wat-1", numberId: cloud.id, trigger: "price", tag: "price-asked", enabled: true, createdAt: iso(20 * DAY) },
          { id: "wat-2", numberId: cloud.id, trigger: "single occupancy", tag: "single-occupancy", enabled: true, createdAt: iso(20 * DAY) },
        ]
      : [],
    welcomeEmail: {
      enabled: false,
      subject: "Welcome to Meridian Wellness",
      body: "Dear {name},\n\nThank you for reaching out. Our team will be in touch shortly.",
      activeFromMin: null,
      activeToMin: null,
      attachmentDocumentId: null,
      attachment: null,
      fromAddress: "hello@meridianwellness.demo",
    },
    tagRules: [
      { tag: "foreign", label: "foreign", strategy: "round_robin", eligibleSubs: [sub("MANAGER")], priority: 0 },
    ],
    numberRules: cloud?.phoneNumber
      ? [{ ourNumber: cloud.phoneNumber, label: cloud.label, strategy: "round_robin", eligibleSubs: [sub("SALES")] }]
      : [],
    availability: Object.fromEntries(
      users
        .filter((u) => u.role !== "VIEWER")
        .map((u, i) => [u.sub, {
          weeklyOffDays: [0],
          shifts: i % 2 ? shift("10:00", "19:00") : shift("09:00", "18:00"),
          leave: u.role === "SALES" && i % 2 === 0
            ? [{ id: `leave-${u.sub}`, startDate: istDay(-3 * DAY), endDate: istDay(-4 * DAY), note: "Family function" }]
            : [],
        }]),
    ),
    userLines: lines.length > 1 ? { [users.find((u) => u.role === "SALES")?.sub ?? ""]: [lines[0]!.phoneNumber!] } : {},
    healthRecords,
    cresent: {
      settings: { enabled: true, recipients: ["partner@agency.demo"], tags: campaignTags, updatedAt: iso(10 * DAY) },
      sends: [
        { id: "cs-1", weekStart: monday(1), rangeEnd: addDays(monday(1), 6), scheduled: true, tags: campaignTags, rowCount: 14,
          emailedAt: iso(((Date.now() + 5.5 * HOUR) % (7 * DAY)) + 2 * HOUR), emailedTo: "partner@agency.demo", emailError: null, createdAt: iso(3 * DAY) },
        { id: "cs-2", weekStart: monday(2), rangeEnd: addDays(monday(2), 6), scheduled: true, tags: campaignTags, rowCount: 19,
          emailedAt: iso(10 * DAY), emailedTo: "partner@agency.demo", emailError: null, createdAt: iso(10 * DAY) },
      ],
    },
    sheetCheck: {
      settings: { enabled: true, intervalDays: 3, recipients: ["director@meridianwellness.demo"], pushMissing: true, lastTickAt: iso(5 * HOUR) },
      sources: [
        { id: "ss-1", name: "Seasonal Detox — Hyderabad", sheetUrl: "https://docs.google.com/spreadsheets/d/demo-sheet-detox/edit#gid=101", campaignLabel: "Seasonal Detox Campaign HYD",
          enabled: true, lastRowNumber: 346, lastCheckedAt: iso(2 * DAY), lastStatus: "ok", lastMessage: "All 14 checked are in the CRM" },
        { id: "ss-2", name: "NRI Health — Hyderabad", sheetUrl: "https://docs.google.com/spreadsheets/d/demo-sheet-nri/edit#gid=202", campaignLabel: "NRI Lead Campaign",
          enabled: true, lastRowNumber: 130, lastCheckedAt: iso(2 * DAY), lastStatus: "missing", lastMessage: "1 of 11 checked were missing — 1 added" },
        { id: "ss-3", name: "Generic Wellness", sheetUrl: "https://docs.google.com/spreadsheets/d/demo-sheet-generic/edit#gid=0", campaignLabel: null,
          enabled: false, lastRowNumber: 841, lastCheckedAt: iso(9 * DAY), lastStatus: "ok", lastMessage: "All 10 checked are in the CRM" },
      ],
      runs: [
        { id: "run-2", trigger: "schedule", dryRun: false, status: "issues", checkedCount: 25, missingCount: 1, pushedCount: 1, pushFailedCount: 0, sheetErrors: 0,
          summary: [
            { sourceId: "ss-1", name: "Seasonal Detox — Hyderabad", tab: "Detox HYD", leadsInSheet: 345, checked: 14, heldBack: 0, missing: 0, pushed: 0, pushFailed: 0, error: null },
            { sourceId: "ss-2", name: "NRI Health — Hyderabad", tab: "NRI Lead Hyd", leadsInSheet: 129, checked: 11, heldBack: 0, missing: 1, pushed: 1, pushFailed: 0, error: null },
          ],
          hasCsv: true, emailedAt: iso(2 * DAY), emailedTo: "director@meridianwellness.demo", emailError: null, error: null, startedAt: iso(2 * DAY), finishedAt: iso(2 * DAY - 40_000) },
        { id: "run-1", trigger: "schedule", dryRun: false, status: "ok", checkedCount: 31, missingCount: 0, pushedCount: 0, pushFailedCount: 0, sheetErrors: 0,
          summary: [
            { sourceId: "ss-1", name: "Seasonal Detox — Hyderabad", tab: "Detox HYD", leadsInSheet: 331, checked: 17, heldBack: 0, missing: 0, pushed: 0, pushFailed: 0, error: null },
            { sourceId: "ss-2", name: "NRI Health — Hyderabad", tab: "NRI Lead Hyd", leadsInSheet: 122, checked: 14, heldBack: 0, missing: 0, pushed: 0, pushFailed: 0, error: null },
          ],
          hasCsv: false, emailedAt: null, emailedTo: null, emailError: null, error: null, startedAt: iso(5 * DAY), finishedAt: iso(5 * DAY - 35_000) },
      ],
    },
  };
}

/**
 * Per-lead detail the new features read, added to the base seed: booking
 * details on the leads closest to a booking, attachment names on a few
 * emails, one archived template, and payment chases.
 */
function enrichBase(db: DemoData) {
  fillLastWeek(db);
  const nearBooking = db.enquiries.filter((e) => ["pricing_shared", "payment_received", "booking_confirmed"].includes(e.stage));
  nearBooking.slice(0, 6).forEach((e, i) => {
    const double = i % 2 === 0;
    e.occupancy = double ? "double" : "single";
    e.companionName = double ? ["Rahul", "Anjali", "Vikram", "Meera"][i % 4]! : null;
    e.stayDays = [7, 5, 10, 14, 7, 3][i]!;
    e.roomCount = double ? 1 : 1;
    e.pricePerDayINR = [18000, 22000, 16500, 28000, 18000, 21000][i]!;
    e.roomCategory = i % 3 === 0 ? "premium" : "executive";
  });

  db.messages
    .filter((m) => m.channel === "email")
    .slice(0, 5)
    .forEach((m, i) => {
      m.attachmentNames = [
        ["Sample Itinerary - Experience Packages.pdf"],
        ["medical-report-2026.pdf"],
        ["Meridian Brochure 2026.pdf", "Rate card.pdf"],
        ["passport-copy.jpg"],
        ["payment-receipt.pdf"],
      ][i]!;
    });

  const oldest = db.messageTemplates.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
  if (oldest) oldest.archivedAt = iso(4 * DAY);

  for (const e of db.enquiries.filter((x) => x.stage === "payment_received" && !x.deletedAt)) {
    if (db.tasks.some((t) => t.enquiryId === e.id && t.kind === "payment_pending" && t.status === "open")) continue;
    const guest = db.guests.find((g) => g.id === e.guestId);
    db.tasks.push({
      id: `task-pay-${e.id}`,
      enquiryId: e.id,
      guestName: guest?.fullName ?? "Guest",
      title: "Payment pending — chase the balance",
      dueAt: iso(-18 * HOUR),
      status: "open",
      kind: "payment_pending",
      approved: null,
      assignedToSub: e.assignedToSub,
      createdBy: "system",
      createdAt: iso(2 * DAY),
      updatedAt: iso(2 * DAY),
    });
  }
}

/** Build the September-2026 state for a fresh seed. */
export function extendSeed(db: DemoData, users: DemoUser[]): DemoData {
  enrichBase(db);
  db.ext = buildExt(db, users);
  return db;
}

/** The ext state, created on first use for a payload saved before it existed. */
export function ensureExt(db: DemoData, users: DemoUser[]): DemoExt {
  if (!db.ext) extendSeed(db, users);
  return db.ext!;
}

/**
 * The weekly client report opens on last Monday–Sunday, and the base seed's
 * campaign leads are spread over months — so move a handful of them (with
 * their calls, messages, notes and activity) into last week. Only leads
 * whose whole history still ends in the past after the move are taken.
 */
function fillLastWeek(db: DemoData) {
  const IST = 5.5 * HOUR;
  const istNow = new Date(Date.now() + IST);
  const monday = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - ((istNow.getUTCDay() + 6) % 7) - 7)).getTime() - IST;
  const shift = (v: string, d: number) => new Date(Date.parse(v) + d).toISOString();
  // The same three campaigns buildExt() picks as the report's default tags.
  const reported = new Set([...new Set(db.enquiries.map((e) => e.campaignLabel).filter(Boolean))].slice(0, 3));
  let n = 0;
  for (const e of db.enquiries) {
    if (n >= 9) break;
    if (!e.campaignLabel || !reported.has(e.campaignLabel) || e.deletedAt || Date.parse(e.createdAt) >= monday) continue;
    const target = monday + (n % 7) * DAY + (10 + (n * 3) % 8) * HOUR + n * 7 * 60_000;
    const cr = Date.parse(e.createdAt);
    const calls = db.calls.filter((c) => c.enquiryId === e.id);
    const msgs = db.messages.filter((m) => m.enquiryId === e.id || (m.guestId === e.guestId && Date.parse(m.createdAt) >= cr));
    const notes = db.notes.filter((x) => x.enquiryId === e.id);
    const acts = db.activities.filter((x) => x.enquiryId === e.id);
    const times = [Date.parse(e.lastActivityAt), ...calls.map((c) => Date.parse(c.startedAt)), ...msgs.map((m) => Date.parse(m.createdAt)), ...notes.map((x) => Date.parse(x.createdAt)), ...acts.map((x) => Date.parse(x.createdAt))];
    const span = Math.max(1, Math.max(...times) - cr);
    // Squeeze the lead's history into [target, now) so it keeps its order
    // and never lands in the future.
    const scale = Math.min(1, (Date.now() - 2 * HOUR - target) / span);
    const move = (v: string) => new Date(target + Math.max(0, Date.parse(v) - cr) * scale).toISOString();
    e.createdAt = new Date(target).toISOString();
    e.updatedAt = move(e.updatedAt);
    e.lastActivityAt = move(e.lastActivityAt);
    for (const c of calls) {
      const d = Date.parse(move(c.startedAt)) - Date.parse(c.startedAt);
      c.startedAt = shift(c.startedAt, d);
      if (c.answeredAt) c.answeredAt = shift(c.answeredAt, d);
      if (c.endedAt) c.endedAt = shift(c.endedAt, d);
    }
    for (const m of msgs) m.createdAt = move(m.createdAt);
    for (const x of notes) x.createdAt = move(x.createdAt);
    for (const x of acts) x.createdAt = move(x.createdAt);
    n += 1;
  }
}
