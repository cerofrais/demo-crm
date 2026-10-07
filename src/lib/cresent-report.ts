/**
 * The Cresent weekly report — the server half: reading leads, calls, remarks
 * and messages, emailing the report, and the Monday schedule. The shape and
 * the rules for what counts as a contact live in cresent-report-shape.ts.
 *
 * WHAT COUNTS AS A CONTACT
 *  • every call on the lead (Call rows — they carry the outcome, including
 *    the unanswered attempts the activity log doesn't record);
 *  • every WhatsApp or email a PERSON sent: the lead's message_sent activity,
 *    from staff in the CRM or from the WhatsApp phone app. Auto-replies and
 *    welcome emails are machines, not follow-ups, and broadcasts never write
 *    that activity at all.
 * Remarks come from the lead's remarks (Notes), matched to the contact they
 * follow — see buildTouches.
 */
import { prisma } from "./prisma";
import { logger } from "./logger";
import { sendEmail } from "./mailer";
import { getMailbox } from "./mailboxes";
import { toCsv } from "./marketing-report";
import { formatTag, isWhatsAppTag, mergeLeadTags } from "./lead-tags";
import {
  addDays,
  addWeeks,
  buildTouches,
  dayRangeBounds,
  callContact,
  CSV_HEADERS,
  csvRows,
  DEFAULT_CRESENT_TAGS,
  groupByDay,
  istWeekStart,
  matchingTags,
  messageContact,
  recordingPaths,
  renderReportHtml,
  weekBounds,
  type CresentLeadDTO,
  type CresentReportDTO,
  type RawContact,
} from "./cresent-report-shape";

/** Hour (IST) on Monday the scheduled send goes out. */
export const SEND_HOUR_IST = 9;

export interface CresentSettingsDTO {
  enabled: boolean;
  recipients: string[];
  tags: string[];
  updatedAt: string | null;
}

export async function getCresentSettings(): Promise<CresentSettingsDTO> {
  const row = await prisma.cresentReportSetting.findUnique({ where: { id: "singleton" } });
  return {
    enabled: row?.enabled ?? false,
    recipients: row?.recipients ?? [],
    // Never saved: start from the default campaigns. Once saved, the saved
    // list stands, even if someone cleared it.
    tags: row ? row.tags : [...DEFAULT_CRESENT_TAGS],
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export async function saveCresentSettings(
  input: { enabled: boolean; recipients: string[]; tags: string[] },
  actorSub: string,
): Promise<CresentSettingsDTO> {
  const data = {
    enabled: input.enabled,
    recipients: [...new Set(input.recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))],
    tags: [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))],
    updatedBy: actorSub,
  };
  await prisma.cresentReportSetting.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...data },
    update: data,
  });
  return getCresentSettings();
}

/** A remark written by an Admin — Note.authorRole is the author's role then. */
function isAdminNote(n: { authorRole: string | null }): boolean {
  return n.authorRole === "ADMIN";
}

/**
 * The top-level folder in the audio zip: the lead's campaign as the board
 * shows it, else the campaign tag that put it in the report, else a catch-all.
 */
function campaignFolderName(campaignLabel: string | null, matched: string[]): string {
  if (campaignLabel?.trim()) return campaignLabel.trim();
  const tag = matched.find((t) => t.startsWith("campaign:")) ?? matched[0];
  return tag ? formatTag(tag).label : "No campaign";
}

/** Human message_sent activity: staff, or the WhatsApp phone app. */
function isHumanSend(a: { actorRole: string; actorSub: string }): boolean {
  return a.actorRole !== "system" || a.actorSub === "whatsapp-mobile";
}

/** How far a message row may sit from its activity and still be that send. */
const SEND_MATCH_MS = 2 * 60 * 1000;

/** Leads received on IST days `range.start` to `range.end`, both included. */
export async function buildCresentReport(range: { start: string; end: string }, tags: string[]): Promise<CresentReportDTO> {
  const { from, to } = dayRangeBounds(range.start, range.end);

  // Tags are matched in code, not in the query: system tags (source, age,
  // campaign, foreign…) are computed on read and aren't reliably stored on
  // the row, and the board filters on the merged set — so must this.
  const candidates = tags.length
    ? await prisma.enquiry.findMany({
        where: { createdAt: { gte: from, lt: to }, deletedAt: null },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          guestId: true,
          createdAt: true,
          stage: true,
          tags: true,
          source: true,
          isReturningFlag: true,
          campaignLabel: true,
          guest: {
            select: { fullName: true, phone: true, email: true, city: true, dateOfBirth: true, isReturning: true, tags: true },
          },
        },
      })
    : [];

  const leads = candidates
    .map((e) => {
      const all = [...mergeLeadTags(e.tags, e.guest, e), ...e.guest.tags.filter(isWhatsAppTag)];
      return { e, matched: matchingTags(all, tags) };
    })
    .filter((x) => x.matched.length > 0);

  const ids = leads.map((x) => x.e.id);
  const [calls, notes, sends] = ids.length
    ? await Promise.all([
        prisma.call.findMany({
          where: { enquiryId: { in: ids } },
          select: {
            id: true,
            enquiryId: true,
            startedAt: true,
            direction: true,
            status: true,
            durationSec: true,
            notes: true,
            recordingUrl: true,
          },
        }),
        prisma.note.findMany({
          // Comments are internal chatter about the lead. This report goes to
          // Cresent, so they are filtered out in the query rather than later
          // — nothing downstream can then leak one by forgetting to check.
          where: { enquiryId: { in: ids }, kind: "remark" },
          select: { enquiryId: true, createdAt: true, body: true, authorRole: true, authorName: true },
        }),
        prisma.activity.findMany({
          where: { enquiryId: { in: ids }, actionType: "message_sent" },
          select: { enquiryId: true, guestId: true, createdAt: true, actorRole: true, actorSub: true, metadata: true },
        }),
      ])
    : [[], [], []];

  const guestIds = [...new Set(leads.map((x) => x.e.guestId))];
  const outbound = guestIds.length
    ? await prisma.message.findMany({
        where: {
          guestId: { in: guestIds },
          direction: "outbound",
          channel: { in: ["whatsapp", "email"] },
          createdAt: { gte: from },
        },
        select: { id: true, guestId: true, channel: true, status: true, createdAt: true },
      })
    : [];

  const rows: CresentLeadDTO[] = leads.map(({ e, matched }) => {
    const leadCalls = calls.filter((c) => c.enquiryId === e.id);
    // Where each recorded call sits in the "Download audios" zip — the same
    // paths the CSV's Call Recording columns print, so the two line up.
    const paths = recordingPaths(
      campaignFolderName(e.campaignLabel, matched),
      { name: e.guest.fullName, phone: e.guest.phone ?? "" },
      leadCalls.filter((c) => c.recordingUrl),
    );
    const contacts: RawContact[] = leadCalls.map((c) =>
      callContact({ ...c, recording: paths.has(c.id) ? { callId: c.id, path: paths.get(c.id)! } : null }),
    );

    const used = new Set<string>();
    for (const a of sends.filter((s) => s.enquiryId === e.id && isHumanSend(s))) {
      const channel = (a.metadata as { channel?: string } | null)?.channel;
      if (channel !== "whatsapp" && channel !== "email") continue;
      // The activity says a person sent it; the message row says whether it
      // arrived. Nearest unused row on the same channel within two minutes.
      const match = outbound
        .filter((m) => m.guestId === e.guestId && m.channel === channel && !used.has(m.id))
        .map((m) => ({ m, gap: Math.abs(m.createdAt.getTime() - a.createdAt.getTime()) }))
        .filter((x) => x.gap <= SEND_MATCH_MS)
        .sort((x, y) => x.gap - y.gap)[0]?.m;
      if (match) used.add(match.id);
      contacts.push(messageContact({ at: a.createdAt, channel, status: match?.status ?? "sent" }));
    }

    // Admin remarks go in their own column, marked as such, instead of being
    // read as the rep's remarks on whichever contact they happen to follow.
    const leadNotes = notes.filter((n) => n.enquiryId === e.id);
    const remarks = leadNotes.filter((n) => !isAdminNote(n)).map((n) => ({ at: n.createdAt, text: n.body }));
    const adminComments = leadNotes
      .filter(isAdminNote)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((n) => ({ at: n.createdAt.toISOString(), text: n.body, author: n.authorName ?? null }));

    return {
      enquiryId: e.id,
      receivedAt: e.createdAt.toISOString(),
      tags: matched,
      name: e.guest.fullName,
      phone: e.guest.phone ?? "",
      email: e.guest.email ?? "",
      city: e.guest.city ?? "",
      touches: buildTouches(contacts, remarks),
      stage: e.stage,
      adminComments,
    };
  });

  return {
    rangeStart: range.start,
    rangeEnd: range.end,
    tags,
    leadCount: rows.length,
    days: groupByDay(rows),
    generatedAt: new Date().toISOString(),
  };
}

const tagLabel = (t: string) => formatTag(t).label;

export function cresentCsv(report: CresentReportDTO): { filename: string; content: string } {
  return {
    filename: `cresent-leads-${report.rangeStart}_to_${report.rangeEnd}.csv`,
    content: toCsv(CSV_HEADERS, csvRows(report, tagLabel)),
  };
}

function periodLabel(report: CresentReportDTO): string {
  const f = (d: string) =>
    new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${d}T00:00:00.000Z`),
    );
  return report.rangeStart === report.rangeEnd ? f(report.rangeStart) : `${f(report.rangeStart)} – ${f(report.rangeEnd)}`;
}

/**
 * Builds and emails the report for a range of days, logging the send.
 * `scheduled` claims that week's unique slot, so the Monday job can't send
 * the same week twice; it always passes a whole Monday–Sunday week.
 */
export async function sendCresentReport(opts: {
  start: string;
  end: string;
  recipients: string[];
  tags: string[];
  scheduled?: boolean;
  actorSub?: string;
}): Promise<{ rowCount: number; to: string }> {
  if (!opts.recipients.length) throw new Error("Add at least one email address to send the report to");
  if (!opts.tags.length) throw new Error("Pick at least one tag — the report only includes tagged leads");

  const mailbox = getMailbox("sales");
  if (!mailbox?.configured) throw new Error("The sales mailbox isn't configured — can't email the report");

  const report = await buildCresentReport({ start: opts.start, end: opts.end }, opts.tags);
  const to = opts.recipients.join(", ");
  const weekStart = new Date(`${opts.start}T00:00:00.000Z`);
  const rangeEnd = new Date(`${opts.end}T00:00:00.000Z`);
  const log = opts.scheduled
    ? await prisma.cresentReport.upsert({
        where: { scheduledWeek: weekStart },
        create: { weekStart, rangeEnd, scheduledWeek: weekStart, tags: opts.tags, rowCount: report.leadCount },
        update: { tags: opts.tags, rowCount: report.leadCount },
      })
    : await prisma.cresentReport.create({
        data: { weekStart, rangeEnd, tags: opts.tags, rowCount: report.leadCount, createdBy: opts.actorSub ?? null },
      });

  const csv = cresentCsv(report);
  const period = periodLabel(report);
  const tagText = opts.tags.map(tagLabel).join(", ");
  const kind = opts.scheduled ? "Weekly lead report" : "Lead report";
  const intro =
    `${kind} for ${period}: ${report.leadCount} lead${report.leadCount === 1 ? "" : "s"} ` +
    `tagged ${tagText}, with the first call or message, three follow-ups and the current stage for each.`;

  try {
    await sendEmail(mailbox, {
      skipFooter: true,
      to,
      subject: `Trē Wellness — ${kind.toLowerCase()}, ${period}`,
      text: `${intro}\n\nThe same table is attached as a CSV.`,
      html:
        `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;">${intro.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>` +
        renderReportHtml(report, tagLabel) +
        `<p style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#666;">Times are IST. The same table is attached as a CSV.</p>`,
      attachments: [{ filename: csv.filename, content: Buffer.from(csv.content, "utf8"), contentType: "text/csv" }],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "send failed";
    await prisma.cresentReport.update({ where: { id: log.id }, data: { emailError: message } });
    throw err;
  }

  await prisma.cresentReport.update({
    where: { id: log.id },
    data: { emailedAt: new Date(), emailedTo: to, emailError: null },
  });
  logger.info({ start: opts.start, end: opts.end, rowCount: report.leadCount, scheduled: !!opts.scheduled }, "cresent report emailed");
  return { rowCount: report.leadCount, to };
}

/**
 * Ticked every 15 minutes. From Monday 09:00 IST, sends the week that just
 * ended — once. The guard is the unique scheduled row, not a timer, so a
 * restart or redeploy can't resend; a failed send is retried on the next
 * tick with the error left on the row for the page to show.
 */
export async function tickWeeklyCresentReport(now = new Date()): Promise<void> {
  try {
    const settings = await getCresentSettings();
    if (!settings.enabled || !settings.recipients.length || !settings.tags.length) return;

    const thisWeek = istWeekStart(now);
    const sendFrom = weekBounds(thisWeek).from.getTime() + SEND_HOUR_IST * 3_600_000;
    if (now.getTime() < sendFrom) return;

    const lastWeek = addWeeks(thisWeek, -1);
    const existing = await prisma.cresentReport.findUnique({
      where: { scheduledWeek: new Date(`${lastWeek}T00:00:00.000Z`) },
    });
    if (existing?.emailedAt) return;

    await sendCresentReport({
      start: lastWeek,
      end: addDays(lastWeek, 6),
      recipients: settings.recipients,
      tags: settings.tags,
      scheduled: true,
    });
  } catch (err) {
    logger.error({ err }, "cresent report: scheduled run failed");
  }
}

export async function listCresentSends(limit = 20) {
  const rows = await prisma.cresentReport.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  return rows.map((r) => ({
    id: r.id,
    weekStart: r.weekStart.toISOString().slice(0, 10),
    // Older rows predate custom ranges and were always a whole week.
    rangeEnd: r.rangeEnd ? r.rangeEnd.toISOString().slice(0, 10) : addDays(r.weekStart.toISOString().slice(0, 10), 6),
    scheduled: r.scheduledWeek !== null,
    tags: r.tags,
    rowCount: r.rowCount,
    emailedAt: r.emailedAt?.toISOString() ?? null,
    emailedTo: r.emailedTo,
    emailError: r.emailError,
    createdAt: r.createdAt.toISOString(),
  }));
}
