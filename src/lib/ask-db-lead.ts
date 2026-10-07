/**
 * Everything the model needs to answer "what is happening with this lead?".
 *
 * A question about one named person is not a SQL question. "Why is Seema Rani
 * still in Contacted" is answered by her stage history, the messages nobody
 * replied to and the call that never connected — four tables, in time order,
 * read as a story. Asking a small model to write that as one query produces
 * something unreadable; assembling it here in code and letting the model
 * narrate what it is given is both more reliable and checkable, because the
 * same timeline is shown on the page next to the answer.
 *
 * Nothing here is model-written: the lookup, the timeline and the caps are all
 * ordinary Prisma reads, so the narrative path never touches ask-db-guard's
 * SQL surface at all. Health records are not read, exactly as on the SQL side.
 */
import { prisma } from "./prisma";
import { fence } from "./ai/safety";

export interface LeadCard {
  enquiryId: string;
  guestId: string;
  name: string;
  phone: string | null;
  city: string | null;
  stage: string;
  source: string;
  owner: string | null;
  campaignLabel: string | null;
  tags: string[];
  createdAt: string;
  lastActivityAt: string;
  deleted: boolean;
}

export interface TimelineRow {
  /** Epoch ms. Sorting is done on this, never on `at`. */
  ts: number;
  at: string;
  kind: "stage" | "message" | "call" | "note" | "task" | "event";
  who: string;
  detail: string;
}

export interface LeadDossier {
  lead: LeadCard;
  timeline: TimelineRow[];
  /** The fenced text handed to the model. */
  prompt: string;
}

/**
 * Newest first, by the real instant.
 *
 * Sorting the formatted strings put "1:24 a.m." after "8:18 a.m." on the same
 * day, which scrambled the story the model was handed — the one thing a
 * timeline has to get right.
 */
export function sortTimelineNewestFirst(rows: TimelineRow[]): TimelineRow[] {
  return [...rows].sort((a, b) => b.ts - a.ts);
}

/**
 * Activity rows that only shadow a richer row.
 *
 * Writing a note also writes an Activity saying "note", and sending a message
 * writes one saying "message sent" — with none of the text. Keeping both put
 * empty stubs in the timeline next to the real thing, and the model cited a
 * stub, so the proof under that sentence was a blank line. The Note and
 * Message rows carry the same event with its content, so the stubs go.
 */
const SHADOW_ACTIVITY = new Set(["note", "message_sent", "message_received"]);

export function isShadowActivity(actionType: string): boolean {
  return SHADOW_ACTIVITY.has(actionType);
}

/** How much history goes in. Enough to explain a stall, small enough for an 8B. */
const LIMITS = { messages: 10, notes: 6, calls: 5, activities: 15, tasks: 6, timeline: 40 };

const ist = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    dateStyle: "short",
    timeStyle: "short",
  }).format(d);

/**
 * Leads matching a name (or a phone number) the admin typed.
 *
 * Deleted leads are included and flagged: "what happened to X" is very often
 * asked precisely because the card is no longer on the board.
 */
export async function findLeadCandidates(needle: string, limit = 8): Promise<LeadCard[]> {
  const term = needle.trim();
  if (term.length < 2) return [];
  const digits = term.replace(/\D/g, "");

  const enquiries = await prisma.enquiry.findMany({
    where: {
      guest: {
        OR: [
          { fullName: { contains: term, mode: "insensitive" } },
          ...(digits.length >= 6 ? [{ phone: { contains: digits } }] : []),
        ],
      },
    },
    include: { guest: { select: { id: true, fullName: true, phone: true, city: true } } },
    orderBy: { lastActivityAt: "desc" },
    take: limit,
  });

  return enquiries.map((e) => ({
    enquiryId: e.id,
    guestId: e.guestId,
    name: e.guest.fullName,
    phone: e.guest.phone,
    city: e.guest.city,
    stage: e.stage,
    source: e.source,
    owner: e.assignedToName,
    campaignLabel: e.campaignLabel,
    tags: e.tags,
    createdAt: ist(e.createdAt),
    lastActivityAt: ist(e.lastActivityAt),
    deleted: Boolean(e.deletedAt),
  }));
}

/** One lead's story: the card, a merged timeline, and the prompt text for it. */
export async function buildLeadDossier(enquiryId: string): Promise<LeadDossier | null> {
  const e = await prisma.enquiry.findUnique({
    where: { id: enquiryId },
    include: {
      guest: { select: { id: true, fullName: true, phone: true, city: true, tags: true, isReturning: true, isBlocked: true } },
      package: { select: { name: true, durationDays: true, basePriceINR: true } },
      notes: { orderBy: { createdAt: "desc" }, take: LIMITS.notes },
      messages: {
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: LIMITS.messages,
        select: { createdAt: true, channel: true, direction: true, subject: true, body: true, status: true, fromEmail: true, transcriptEnglish: true },
      },
      calls: {
        orderBy: { startedAt: "desc" },
        take: LIMITS.calls,
        select: { startedAt: true, direction: true, status: true, durationSec: true, repName: true, notes: true, aiSummary: true },
      },
      tasks: { orderBy: { createdAt: "desc" }, take: LIMITS.tasks },
      activities: { orderBy: { createdAt: "desc" }, take: LIMITS.activities },
    },
  });
  if (!e) return null;

  const lead: LeadCard = {
    enquiryId: e.id,
    guestId: e.guestId,
    name: e.guest.fullName,
    phone: e.guest.phone,
    city: e.guest.city,
    stage: e.stage,
    source: e.source,
    owner: e.assignedToName,
    campaignLabel: e.campaignLabel,
    tags: e.tags,
    createdAt: ist(e.createdAt),
    lastActivityAt: ist(e.lastActivityAt),
    deleted: Boolean(e.deletedAt),
  };

  const timeline: TimelineRow[] = [];

  for (const a of e.activities) {
    if (isShadowActivity(a.actionType)) continue;
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const detail =
      a.actionType === "stage_change"
        ? `moved ${String(meta.from ?? "?")} → ${String(meta.to ?? "?")}`
        : a.actionType.replace(/_/g, " ");
    timeline.push({ ts: a.createdAt.getTime(), at: ist(a.createdAt), kind: a.actionType === "stage_change" ? "stage" : "event", who: a.actorName ?? a.actorSub, detail });
  }
  for (const m of e.messages) {
    const text = (m.transcriptEnglish ?? m.body ?? "").replace(/\s+/g, " ").trim();
    timeline.push({
      ts: m.createdAt.getTime(),
      at: ist(m.createdAt),
      kind: "message",
      who: m.direction === "inbound" ? lead.name : `staff${m.fromEmail ? ` (${m.fromEmail})` : ""}`,
      detail: `${m.channel} ${m.direction}${m.status === "failed" ? " FAILED" : ""}: ${text.slice(0, 220)}`,
    });
  }
  for (const c of e.calls) {
    timeline.push({
      ts: c.startedAt.getTime(),
      at: ist(c.startedAt),
      kind: "call",
      who: c.repName ?? "unknown rep",
      detail: `${c.direction} call, ${c.status}, ${Math.round(c.durationSec / 60)} min${c.aiSummary ? ` — ${c.aiSummary.slice(0, 200)}` : c.notes ? ` — ${c.notes.slice(0, 200)}` : ""}`,
    });
  }
  for (const n of e.notes) {
    timeline.push({ ts: n.createdAt.getTime(), at: ist(n.createdAt), kind: "note", who: n.authorName ?? n.authorSub, detail: n.body.replace(/\s+/g, " ").slice(0, 220) });
  }
  for (const t of e.tasks) {
    timeline.push({ ts: t.createdAt.getTime(), at: ist(t.createdAt), kind: "task", who: t.assignedToSub ?? t.createdBy, detail: `${t.status} · ${t.title}${t.dueAt ? ` (due ${ist(t.dueAt)})` : ""}` });
  }

  const trimmed = sortTimelineNewestFirst(timeline).slice(0, LIMITS.timeline);

  // Everything a lead or guest wrote goes inside a DATA fence: message bodies
  // and notes are attacker-controlled text, and this prompt asks for prose,
  // which is exactly what an injected instruction would try to steer.
  const lines: string[] = [
    `LEAD: ${lead.name}${lead.deleted ? " — THIS LEAD IS DELETED" : ""}`,
    `Stage: ${lead.stage} · Source: ${lead.source} · Owner: ${lead.owner ?? "unassigned"} · Campaign: ${lead.campaignLabel ?? "none"}`,
    `Phone: ${lead.phone ?? "none"} · City: ${lead.city ?? "unknown"} · Guest tags: ${e.guest.tags.join(", ") || "none"}${e.guest.isBlocked ? " · GUEST IS BLOCKED" : ""}${e.guest.isReturning ? " · returning guest" : ""}`,
    `Lead tags: ${lead.tags.join(", ") || "none"}`,
    `Package: ${e.package ? `${e.package.name} (${e.package.durationDays}d, ₹${e.package.basePriceINR})` : "none"} · Quoted: ${e.quotedPriceINR ? `₹${e.quotedPriceINR}` : "not quoted"}`,
    `Created: ${lead.createdAt} · Last activity: ${lead.lastActivityAt} (times are IST)`,
    e.lostReason ? `Lost reason: ${e.lostReason}` : "",
    "",
    "TIMELINE, NEWEST FIRST. Each entry carries its number, as [n] or n=…:",
  ].filter(Boolean);

  // Every entry is numbered, and the model is asked to cite those numbers.
  // The citation is what turns a summary into a root-cause answer that can be
  // checked: the page then shows the CITED ENTRIES back from this same array,
  // verbatim, so the proof under a claim is database text rather than
  // something the model wrote.
  trimmed.forEach((row, i) => {
    const n = i + 1;
    lines.push(
      row.kind === "message" || row.kind === "note"
        ? fence(row.kind === "message" ? "MESSAGE" : "NOTE", row.detail, { n, at: row.at, by: row.who })
        : `[${n}] ${row.at} · ${row.kind} · ${row.who}: ${row.detail}`,
    );
  });

  return { lead, timeline: trimmed, prompt: lines.join("\n") };
}
