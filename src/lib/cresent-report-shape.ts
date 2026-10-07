/**
 * The Cresent weekly report — the pure half: week arithmetic, turning a
 * lead's calls and messages into its first three contacts, and laying the
 * rows out the way the report reads. No database access, so it is shared by
 * the server (lib/cresent-report.ts) and the Reports page, and tested
 * directly.
 *
 * THE SHAPE
 * One row per lead received in the week, grouped by the IST day it arrived
 * (the Date and Number of Leads cells span that day's rows). Each lead then
 * shows when it was created, its Primary Communication and three follow-ups
 * — each a date, the rep's remarks, and a status — and the stage it is in now.
 */
import type { EnquiryStage } from "@prisma/client";
import { stageLabel } from "./kanban";

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/** A report in the format the page and the email share. */
export interface CresentTouchDTO {
  at: string;
  channel: ContactChannel;
  status: string;
  remarks: string;
  /** Call touches only: each recorded call in this contact, with its path
   *  inside the "Download audios" zip — the CSV's Call Recording column. */
  recordings?: { callId: string; path: string }[];
}

/** A remark an Admin wrote on the lead — reported in its own column rather
 *  than mixed into the reps' remarks under each contact. */
export interface CresentAdminCommentDTO {
  at: string;
  text: string;
  author: string | null;
}

export interface CresentLeadDTO {
  enquiryId: string;
  receivedAt: string;
  /** The selected tags this lead carries — why it is in the report. */
  tags: string[];
  name: string;
  phone: string;
  email: string;
  city: string;
  /** Up to four: primary, then follow-ups 1–3. */
  touches: CresentTouchDTO[];
  /** Where the lead is now — the Final Stage column. */
  stage: EnquiryStage;
  /** Oldest first. Optional so a report built by an older client still reads. */
  adminComments?: CresentAdminCommentDTO[];
}

/**
 * Selected until someone saves their own choice: the campaigns the report was
 * built for. `campaign:seasonal-detox` is the label the Seasonal Detox leads
 * carried before the campaigns were split by region.
 */
export const DEFAULT_CRESENT_TAGS = [
  "campaign:nri-lead-campaign",
  "campaign:seasonal-detox-campaign-ap-tel",
  "campaign:seasonal-detox-campaign-hyd",
  "campaign:seasonal-detox",
];

export interface CresentDayDTO {
  /** IST calendar date, YYYY-MM-DD. */
  day: string;
  leads: CresentLeadDTO[];
}

export interface CresentReportDTO {
  /** First IST day covered, YYYY-MM-DD. A week (Monday) or a custom start. */
  rangeStart: string;
  /** Last IST day covered, inclusive. */
  rangeEnd: string;
  tags: string[];
  leadCount: number;
  days: CresentDayDTO[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Weeks — Monday to Sunday, in IST
// ---------------------------------------------------------------------------

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Monday (IST) of the week `now` falls in, as YYYY-MM-DD. */
export function istWeekStart(now: Date): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const sinceMonday = (ist.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - sinceMonday));
  return ymd(monday);
}

/** Shift a YYYY-MM-DD by whole weeks. */
export function addWeeks(weekStart: string, weeks: number): string {
  return ymd(new Date(Date.parse(`${weekStart}T00:00:00.000Z`) + weeks * 7 * DAY_MS));
}

/** The instants a week covers: Monday 00:00 IST up to the next Monday. */
export function weekBounds(weekStart: string): { from: Date; to: Date } {
  const from = new Date(Date.parse(`${weekStart}T00:00:00.000Z`) - IST_OFFSET_MS);
  return { from, to: new Date(from.getTime() + 7 * DAY_MS) };
}

export function isWeekStart(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && ymd(d) === value && d.getUTCDay() === 1;
}

/** A real calendar date written as YYYY-MM-DD (rejects 2026-02-30). */
export function isYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && ymd(d) === value;
}

/** Shift a YYYY-MM-DD by whole days. */
export function addDays(day: string, days: number): string {
  return ymd(new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS));
}

/** Longest custom range the report builds — a quarter is plenty to read. */
export const MAX_RANGE_DAYS = 92;

/** Days from `start` to `end`, both included. */
export function rangeDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / DAY_MS) + 1;
}

/** The instants whole IST days cover: `start` 00:00 IST up to the day after `end`. */
export function dayRangeBounds(start: string, end: string): { from: Date; to: Date } {
  return {
    from: new Date(Date.parse(`${start}T00:00:00.000Z`) - IST_OFFSET_MS),
    to: new Date(Date.parse(`${end}T00:00:00.000Z`) + DAY_MS - IST_OFFSET_MS),
  };
}

/** The IST calendar day an instant falls on, YYYY-MM-DD. */
export function istDay(d: Date): string {
  return ymd(new Date(d.getTime() + IST_OFFSET_MS));
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export type ContactChannel = "call" | "whatsapp" | "email";

export interface RawContact {
  at: Date;
  channel: ContactChannel;
  /** What happened, already worded — "Connected (2m 02s)", "Read". */
  outcome: string;
  /** Higher is better; a merged contact reports its best outcome. */
  rank: number;
  /** A note typed on the call itself, when there is one. */
  note?: string | null;
  /** A recorded call: its id and path in the audio zip. */
  recording?: { callId: string; path: string } | null;
}

export interface Remark {
  at: Date;
  text: string;
}

/** Same channel within this long of the previous one = the same contact. */
export const MERGE_WINDOW_MS = 60 * 60 * 1000;

const fmtDuration = (sec: number) => `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;

/** A call, worded for the Status column. */
export function callContact(c: {
  startedAt: Date;
  direction: "inbound" | "outbound";
  status: string;
  durationSec: number;
  notes?: string | null;
  recording?: { callId: string; path: string } | null;
}): RawContact {
  let outcome: string;
  let rank: number;
  switch (c.status) {
    case "completed":
    case "connected":
      // durationSec is the guest leg; a "completed" call with none recorded
      // still connected, it just has no length to show.
      outcome = c.durationSec > 0 ? `Connected (${fmtDuration(c.durationSec)})` : "Connected";
      rank = 3;
      break;
    case "voicemail":
      outcome = "Voicemail";
      rank = 2;
      break;
    case "no_answer":
      outcome = "Not answered";
      rank = 1;
      break;
    case "failed":
      outcome = "Failed";
      rank = 0;
      break;
    default:
      outcome = "Not connected";
      rank = 0;
  }
  return {
    at: c.startedAt,
    channel: "call",
    outcome: c.direction === "inbound" ? `${outcome} (incoming)` : outcome,
    rank,
    note: c.notes,
    recording: c.recording ?? null,
  };
}

const MESSAGE_RANK: Record<string, number> = { read: 3, delivered: 2, sent: 1, failed: 0 };

/** A message we sent, worded for the Status column. */
export function messageContact(m: { at: Date; channel: "whatsapp" | "email"; status: string }): RawContact {
  const status = MESSAGE_RANK[m.status] !== undefined ? m.status : "sent";
  return {
    at: m.at,
    channel: m.channel,
    outcome: status[0].toUpperCase() + status.slice(1),
    rank: MESSAGE_RANK[status],
  };
}

const CHANNEL_LABEL: Record<ContactChannel, string> = { call: "Call", whatsapp: "WhatsApp", email: "Email" };

/**
 * A lead's contacts, in order, with bursts folded together.
 *
 * Without folding, a rep who sends a brochure, the price list and a line of
 * text in one go would fill Primary, Follow-up 1 and Follow-up 2 with a
 * single conversation — and two quick redials would do the same. So a
 * contact on the same channel within an hour of the previous one joins it;
 * a different channel always starts a new one ("didn't pick up, sent a
 * WhatsApp" is two contacts).
 *
 * Remarks are the rep's notes written after a contact and before the next
 * one — plus any note typed on the call itself. None means an empty cell,
 * never a guess.
 */
export function buildTouches(contacts: RawContact[], remarks: Remark[], limit = TOUCH_TITLES.length): CresentTouchDTO[] {
  const sorted = [...contacts].sort((a, b) => a.at.getTime() - b.at.getTime());

  const groups: {
    first: Date;
    last: Date;
    channel: ContactChannel;
    best: RawContact;
    count: number;
    notes: string[];
    recordings: { callId: string; path: string }[];
  }[] = [];
  for (const c of sorted) {
    const prev = groups[groups.length - 1];
    if (prev && prev.channel === c.channel && c.at.getTime() - prev.last.getTime() <= MERGE_WINDOW_MS) {
      prev.last = c.at;
      prev.count += 1;
      if (c.rank > prev.best.rank) prev.best = c;
      if (c.note?.trim()) prev.notes.push(c.note.trim());
      // Two quick redials fold into one contact — both recordings belong to it.
      if (c.recording) prev.recordings.push(c.recording);
      continue;
    }
    groups.push({
      first: c.at,
      last: c.at,
      channel: c.channel,
      best: c,
      count: 1,
      notes: c.note?.trim() ? [c.note.trim()] : [],
      recordings: c.recording ? [c.recording] : [],
    });
  }

  const byTime = [...remarks].sort((a, b) => a.at.getTime() - b.at.getTime());
  return groups.slice(0, limit).map((g, i) => {
    const next = groups[i + 1]?.first.getTime() ?? Infinity;
    const after = byTime
      .filter((r) => r.at.getTime() >= g.first.getTime() && r.at.getTime() < next)
      .map((r) => r.text.trim())
      .filter(Boolean);
    const unit = g.channel === "call" ? "calls" : "messages";
    return {
      at: g.first.toISOString(),
      channel: g.channel,
      status: `${CHANNEL_LABEL[g.channel]} — ${g.best.outcome}${g.count > 1 ? ` · ${g.count} ${unit}` : ""}`,
      remarks: [...g.notes, ...after].join("\n"),
      ...(g.recordings.length ? { recordings: g.recordings } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Tags — ANY of the selected tags
// ---------------------------------------------------------------------------

/** The selected tags a lead carries; empty means it isn't in the report. */
export function matchingTags(leadTags: string[], selected: string[]): string[] {
  return selected.filter((t) => leadTags.includes(t));
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function groupByDay(leads: CresentLeadDTO[]): CresentDayDTO[] {
  const days = new Map<string, CresentLeadDTO[]>();
  for (const lead of [...leads].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    const day = istDay(new Date(lead.receivedAt));
    days.set(day, [...(days.get(day) ?? []), lead]);
  }
  return [...days.entries()].map(([day, list]) => ({ day, leads: list }));
}

/** "6 July" — the Date column, as the report has always written it. */
export function dayLabel(day: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00.000Z`),
  );
}

/** "8 Jul, 10:32 am" in IST. */
export function contactTimeLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

export const USER_DETAIL_COLUMNS = ["Name", "Phone No.", "Email ID", "City"] as const;
export const TOUCH_TITLES = ["Primary Communication", "Follow Up 1", "Follow Up 2", "Follow Up 3"] as const;
/** On screen and in the email body: date, remarks, status per contact. */
export const TOUCH_HEADERS = TOUCH_TITLES.flatMap((t) => [`${t} Date`, `${t} Remarks`, `${t} Status`]);
/** The CSV adds each contact's call recording(s) — a path into the audio zip,
 *  which is only meaningful next to that zip, so it stays out of the screen
 *  and the email body. */
export const CSV_TOUCH_HEADERS = TOUCH_TITLES.flatMap((t) => [
  `${t} Date`,
  `${t} Remarks`,
  `${t} Status`,
  `${t} Call Recording`,
]);
export const CREATED_AT_COLUMN = "Created At";
export const FINAL_STAGE_COLUMN = "Final Stage";
export const ADMIN_COMMENTS_COLUMN = "Admin Comments";

export const CSV_HEADERS = [
  "Date",
  "Number of Leads Received",
  "Tags",
  ...USER_DETAIL_COLUMNS,
  CREATED_AT_COLUMN,
  ...CSV_TOUCH_HEADERS,
  FINAL_STAGE_COLUMN,
  ADMIN_COMMENTS_COLUMN,
];

/**
 * Date, remarks and status for each contact column — blank where there was
 * no such contact. `withRecordings` adds the Call Recording cell (the CSV).
 */
export function touchCells(lead: CresentLeadDTO, opts: { withRecordings?: boolean } = {}): string[] {
  return TOUCH_TITLES.flatMap((_, n) => {
    const t = lead.touches[n];
    const base = t ? [contactTimeLabel(t.at), t.remarks, t.status] : ["", "", ""];
    if (!opts.withRecordings) return base;
    return [...base, (t?.recordings ?? []).map((r) => r.path).join("\n")];
  });
}

/** The Admin Comments cell: "22 Sep, 10:15 am — Priya: call back after Diwali". */
export function adminCommentsCell(lead: CresentLeadDTO): string {
  return (lead.adminComments ?? [])
    .map((c) => `${contactTimeLabel(c.at)} — ${c.author ? `${c.author}: ` : ""}${c.text.trim()}`)
    .join("\n");
}

/** Every recording the report's CSV points at, once each. */
export function reportRecordings(report: CresentReportDTO): { callId: string; path: string }[] {
  const seen = new Map<string, string>();
  for (const d of report.days)
    for (const lead of d.leads)
      for (const t of lead.touches) for (const r of t.recordings ?? []) if (!seen.has(r.callId)) seen.set(r.callId, r.path);
  return [...seen].map(([callId, path]) => ({ callId, path }));
}

// ---------------------------------------------------------------------------
// Audio zip layout — campaign / lead / file
// ---------------------------------------------------------------------------

/**
 * One path segment, safe on Windows, macOS and Linux: no separators or
 * reserved characters, no trailing dot or space (Windows drops them), and
 * short enough that three segments stay well inside path limits.
 */
export function safeSegment(value: string, fallback: string): string {
  const cleaned = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

/** The lead's folder: name plus phone, since two leads can share a name. */
export function leadFolder(name: string, phone: string): string {
  const who = safeSegment(name, "Unnamed lead");
  const digits = phone.replace(/[^\d+]/g, "");
  return digits ? safeSegment(`${who} (${digits})`, who) : who;
}

/** "2026-09-18_14-32_outgoing_connected.mp3" — IST, sortable, self-describing. */
export function recordingFileName(call: { startedAt: Date; direction: "inbound" | "outbound"; status: string }): string {
  const ist = new Date(call.startedAt.getTime() + IST_OFFSET_MS).toISOString();
  const stamp = `${ist.slice(0, 10)}_${ist.slice(11, 13)}-${ist.slice(14, 16)}`;
  const dir = call.direction === "inbound" ? "incoming" : "outgoing";
  const status = call.status === "completed" || call.status === "connected" ? "connected" : call.status.replace(/_/g, "-");
  return `${stamp}_${dir}_${status}.mp3`;
}

/**
 * Zip paths for a lead's recorded calls, keyed by call id. Two calls in the
 * same minute would share a file name, so the later ones get "-2", "-3".
 */
export function recordingPaths(
  campaign: string,
  lead: { name: string; phone: string },
  calls: { id: string; startedAt: Date; direction: "inbound" | "outbound"; status: string }[],
): Map<string, string> {
  const folder = `${safeSegment(campaign, "No campaign")}/${leadFolder(lead.name, lead.phone)}`;
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const c of [...calls].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())) {
    const base = recordingFileName(c);
    let name = base;
    for (let n = 2; used.has(name); n++) name = base.replace(/\.mp3$/, `-${n}.mp3`);
    used.add(name);
    out.set(c.id, `${folder}/${name}`);
  }
  return out;
}

/**
 * Flat rows for the CSV. Date and count sit on a day's first row only,
 * mirroring the merged cells of the on-screen and emailed tables.
 */
export function csvRows(report: CresentReportDTO, tagLabel: (t: string) => string): string[][] {
  const rows: string[][] = [];
  for (const d of report.days) {
    d.leads.forEach((lead, i) => {
      rows.push([
        i === 0 ? dayLabel(d.day) : "",
        i === 0 ? String(d.leads.length) : "",
        lead.tags.map(tagLabel).join(", "),
        lead.name,
        lead.phone,
        lead.email,
        lead.city,
        contactTimeLabel(lead.receivedAt),
        ...touchCells(lead, { withRecordings: true }),
        stageLabel(lead.stage),
        adminCommentsCell(lead),
      ]);
    });
  }
  return rows;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "<br>");

/**
 * The emailed table. Inline styles only — mail clients drop <style> blocks —
 * and the same merged header as the original spreadsheet: "User Necessary
 * Details" over its four columns, Date and Number of Leads spanning a day.
 */
export function renderReportHtml(report: CresentReportDTO, tagLabel: (t: string) => string): string {
  const th = (label: string, attrs = "") =>
    `<th ${attrs} style="background:#111;color:#fff;border:1px solid #444;padding:6px 8px;font-size:12px;font-weight:600;text-align:center;">${esc(label)}</th>`;
  const td = (value: string, attrs = "") =>
    `<td ${attrs} style="border:1px solid #bbb;padding:5px 8px;font-size:12px;vertical-align:top;">${esc(value)}</td>`;

  const head1 = [
    th("Date", 'rowspan="2"'),
    th("Number of Leads Received", 'rowspan="2"'),
    th("Tags", 'rowspan="2"'),
    th("User Necessary Details (Name / phone no. / email ID etc)", `colspan="${USER_DETAIL_COLUMNS.length}"`),
    th(CREATED_AT_COLUMN, 'rowspan="2"'),
    ...TOUCH_HEADERS.map((h) => th(h, 'rowspan="2"')),
    th(FINAL_STAGE_COLUMN, 'rowspan="2"'),
    th(ADMIN_COMMENTS_COLUMN, 'rowspan="2"'),
  ].join("");
  const head2 = USER_DETAIL_COLUMNS.map((c) => th(c)).join("");

  const body = report.days
    .flatMap((d) =>
      d.leads.map((lead, i) => {
        const span = `rowspan="${d.leads.length}"`;
        const cells = [
          ...(i === 0 ? [td(dayLabel(d.day), `${span} align="center"`), td(String(d.leads.length), `${span} align="center"`)] : []),
          td(lead.tags.map(tagLabel).join(", ")),
          td(lead.name),
          td(lead.phone),
          td(lead.email),
          td(lead.city),
          td(contactTimeLabel(lead.receivedAt)),
          ...touchCells(lead).map((c) => td(c)),
          td(stageLabel(lead.stage)),
          td(adminCommentsCell(lead)),
        ];
        return `<tr>${cells.join("")}</tr>`;
      }),
    )
    .join("");

  const empty = report.leadCount === 0
    ? `<tr><td colspan="${3 + USER_DETAIL_COLUMNS.length + 1 + TOUCH_HEADERS.length + 2}" style="border:1px solid #bbb;padding:12px;font-size:12px;text-align:center;color:#666;">No leads with these tags this week.</td></tr>`
    : "";

  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;"><thead><tr>${head1}</tr><tr>${head2}</tr></thead><tbody>${body}${empty}</tbody></table>`;
}
