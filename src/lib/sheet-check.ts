/**
 * Lead sheet check — confirms that leads in the Meta lead-ad Google Sheets
 * actually reached the CRM, and repairs it when they didn't.
 *
 * Every few days (SheetCheckSetting.intervalDays, 3 by default) each
 * configured sheet is read and the last ten leads, plus every lead added
 * since the previous check, are looked up in the CRM. Any that are missing
 * are pushed through the same path the n8n workflow uses, written to a CSV,
 * and emailed to the recipients (the CEO by default).
 *
 * The schedule lives in the sheet-check-cron container, which calls
 * tickSheetCheck() once a day; the interval is enforced here against the last
 * run, so a container restart or a missed day can't double up or drift.
 * The pure rules — parsing, row selection, matching, payload — are in
 * sheet-check-parse.ts.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { redis } from "./redis";
import { sendEmail } from "./mailer";
import { getMailbox } from "./mailboxes";
import { putObjectBuffer, getObjectBuffer } from "./storage";
import { toCsv } from "./marketing-report";
import { parseSheetUrl, readSheet, serviceAccountEmail } from "./google-sheets";
import { ingestWebhookEnquiry } from "./enquiry-webhook-ingest";
import {
  buildPushPayload,
  isDue,
  isInCrm,
  parseLeadRows,
  phoneKey,
  selectLeadsToCheck,
  type CrmIndex,
  type SheetLead,
} from "./sheet-check-parse";

const LOCK_KEY = "sheet-check:lock";

// ---------------------------------------------------------------------------
// Settings and sheets
// ---------------------------------------------------------------------------

export interface SheetCheckSettingsDTO {
  enabled: boolean;
  intervalDays: number;
  recipients: string[];
  pushMissing: boolean;
  lastTickAt: string | null;
}

export async function getSettings(): Promise<SheetCheckSettingsDTO> {
  const row = await prisma.sheetCheckSetting.findUnique({ where: { id: "singleton" } });
  return {
    enabled: row?.enabled ?? true,
    intervalDays: row?.intervalDays ?? 3,
    recipients: row?.recipients ?? ["ceo@trewellness.in"],
    pushMissing: row?.pushMissing ?? true,
    lastTickAt: row?.lastTickAt?.toISOString() ?? null,
  };
}

export async function saveSettings(
  input: { enabled: boolean; intervalDays: number; recipients: string[]; pushMissing: boolean },
  actorSub: string,
): Promise<SheetCheckSettingsDTO> {
  const data = {
    enabled: input.enabled,
    intervalDays: input.intervalDays,
    recipients: [...new Set(input.recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))],
    pushMissing: input.pushMissing,
    updatedBy: actorSub,
  };
  await prisma.sheetCheckSetting.upsert({ where: { id: "singleton" }, create: { id: "singleton", ...data }, update: data });
  return getSettings();
}

export async function listSources() {
  const rows = await prisma.sheetCheckSource.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sheetUrl: r.sheetUrl,
    campaignLabel: r.campaignLabel,
    enabled: r.enabled,
    lastRowNumber: r.lastRowNumber,
    lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
    lastStatus: r.lastStatus,
    lastMessage: r.lastMessage,
  }));
}

export async function createSource(
  input: { sheetUrl: string; name?: string | null; campaignLabel?: string | null },
  actorSub: string,
) {
  const parsed = parseSheetUrl(input.sheetUrl);
  if (!parsed) throw new Error("That isn't a Google Sheets link");
  let name = input.name?.trim();
  if (!name) {
    // Name it after the tab when the sheet is already readable; otherwise a
    // placeholder the user can rename once access is sorted out.
    name = await readSheet(parsed.spreadsheetId, parsed.gid).then((s) => s.tabTitle, () => "Lead sheet");
  }
  return prisma.sheetCheckSource.create({
    data: {
      name,
      sheetUrl: input.sheetUrl.trim(),
      spreadsheetId: parsed.spreadsheetId,
      gid: parsed.gid,
      campaignLabel: input.campaignLabel?.trim() || null,
      createdBy: actorSub,
    },
  });
}

export async function updateSource(id: string, input: { name?: string; campaignLabel?: string | null; enabled?: boolean }) {
  return prisma.sheetCheckSource.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.campaignLabel !== undefined && { campaignLabel: input.campaignLabel?.trim() || null }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    },
  });
}

export async function deleteSource(id: string): Promise<void> {
  await prisma.sheetCheckSource.delete({ where: { id } });
}

/** Reads a sheet without changing anything — for the page's Test button. */
export async function testSource(id: string) {
  const source = await prisma.sheetCheckSource.findUnique({ where: { id } });
  if (!source) throw new Error("Sheet not found");
  const sheet = await readSheet(source.spreadsheetId, source.gid);
  const parsed = parseLeadRows(sheet.values);
  const last = parsed.leads[parsed.leads.length - 1];
  return {
    spreadsheetTitle: sheet.spreadsheetTitle,
    tabTitle: sheet.tabTitle,
    rows: sheet.values.length,
    leads: parsed.leads.length,
    headerRow: parsed.headerRow,
    skipped: parsed.skipped.length,
    lastLead: last ? { rowNumber: last.rowNumber, createdTime: last.createdTime } : null,
  };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

async function loadCrmIndex(leads: SheetLead[]): Promise<CrmIndex> {
  const metaIds = [...new Set(leads.map((l) => l.metaId).filter((x): x is string => !!x))];
  const keys = [...new Set(leads.map((l) => phoneKey(l.phone)).filter((x): x is string => !!x))];
  const emails = [...new Set(leads.map((l) => l.email?.toLowerCase()).filter((x): x is string => !!x))];

  const [refs, phones, mails] = await Promise.all([
    metaIds.length
      ? prisma.enquiry.findMany({ where: { externalRef: { in: metaIds } }, select: { externalRef: true } })
      : [],
    // Deleted guests count as arrived: a lead someone deleted wasn't missed.
    keys.length
      ? prisma.$queryRaw<{ k: string }[]>`
          SELECT DISTINCT right(regexp_replace(phone, '\\D', '', 'g'), 10) AS k
          FROM "Guest"
          WHERE phone IS NOT NULL AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = ANY(${keys}::text[])`
      : [],
    emails.length
      ? prisma.guest.findMany({ where: { email: { in: emails, mode: "insensitive" } }, select: { email: true } })
      : [],
  ]);
  return {
    externalRefs: new Set(refs.map((r) => r.externalRef).filter((x): x is string => !!x)),
    phoneKeys: new Set(phones.map((p) => p.k)),
    emails: new Set(mails.map((m) => m.email!.toLowerCase())),
  };
}

type Outcome =
  | { kind: "created"; enquiryId: string }
  | { kind: "merged"; enquiryId: string }
  | { kind: "duplicate"; enquiryId: string }
  | { kind: "failed"; error: string }
  | { kind: "not_pushed"; reason: string };

const OUTCOME_TEXT: Record<Outcome["kind"], string> = {
  created: "Added to CRM now",
  merged: "Merged into an existing lead",
  duplicate: "Already in CRM (same Meta lead id)",
  failed: "Push failed",
  not_pushed: "Not added",
};

interface MissingRow {
  sheet: string;
  tab: string;
  lead: SheetLead;
  campaignLabel: string | undefined;
  outcome: Outcome;
}

interface SheetSummary {
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

const istStamp = (d: Date | null) => (d ? new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 16).replace("T", " ") : "");

export const CSV_HEADERS = [
  "Sheet", "Tab", "Sheet row", "Meta lead ID", "Lead received (IST)", "Name", "Phone", "Email", "City",
  "Platform", "Campaign", "Form", "Form answers", "Result", "Detail", "CRM lead ID",
];

function csvRow(m: MissingRow): (string | number)[] {
  const o = m.outcome;
  return [
    m.sheet,
    m.tab,
    m.lead.rowNumber,
    m.lead.metaId ?? "",
    istStamp(m.lead.createdAt) || (m.lead.createdTime ?? ""),
    m.lead.fullName,
    m.lead.phone,
    m.lead.email ?? "",
    m.lead.city ?? "",
    m.lead.platform === "ig" ? "Instagram" : m.lead.platform === "fb" ? "Facebook" : (m.lead.platform ?? ""),
    m.campaignLabel ?? "",
    m.lead.formName ?? "",
    m.lead.answers.map((a) => `${a.question}: ${a.answer}`).join("\n"),
    OUTCOME_TEXT[o.kind],
    o.kind === "failed" ? o.error : o.kind === "not_pushed" ? o.reason : "",
    "enquiryId" in o ? o.enquiryId : "",
  ];
}

export interface RunResult {
  runId: string;
  status: string;
  checked: number;
  missing: number;
  pushed: number;
  pushFailed: number;
  sheetErrors: number;
  sheets: SheetSummary[];
  missingLeads: { sheet: string; rowNumber: number; name: string; receivedAt: string | null; result: string }[];
  emailedTo: string | null;
  emailError: string | null;
}

/**
 * One full check across every enabled sheet.
 * `dryRun` reports only: nothing is pushed or emailed and the "since last
 * check" watermark stays where it was.
 */
export async function runSheetCheck(opts: { trigger: "schedule" | "manual"; dryRun: boolean; actorSub?: string }): Promise<RunResult> {
  const locked = await redis.set(LOCK_KEY, "1", "EX", 1800, "NX").catch(() => "OK");
  if (locked === null) throw new Error("A sheet check is already running — try again in a few minutes");

  const run = await prisma.sheetCheckRun.create({
    data: { trigger: opts.trigger, dryRun: opts.dryRun, createdBy: opts.actorSub ?? null },
  });

  try {
    const settings = await getSettings();
    const sources = await prisma.sheetCheckSource.findMany({ where: { enabled: true }, orderBy: { createdAt: "asc" } });
    if (!sources.length) throw new Error("No sheets are set up to check");
    if (!serviceAccountEmail()) throw new Error("Google access isn't set up — GOOGLE_SERVICE_ACCOUNT_JSON is missing on the server");

    const now = new Date();
    const summaries: SheetSummary[] = [];
    const missingRows: MissingRow[] = [];

    for (const source of sources) {
      const summary: SheetSummary = {
        sourceId: source.id, name: source.name, tab: null, leadsInSheet: 0, checked: 0,
        heldBack: 0, missing: 0, pushed: 0, pushFailed: 0, error: null,
      };
      summaries.push(summary);
      try {
        const sheet = await readSheet(source.spreadsheetId, source.gid);
        summary.tab = sheet.tabTitle;
        const { leads } = parseLeadRows(sheet.values);
        summary.leadsInSheet = leads.length;

        const { toCheck, tooRecent } = selectLeadsToCheck(leads, source, now);
        summary.checked = toCheck.length;
        summary.heldBack = tooRecent.length;

        const crm = await loadCrmIndex(toCheck);
        const missing = toCheck.filter((l) => !isInCrm(l, crm));
        summary.missing = missing.length;

        let earliestUnresolved: SheetLead | null = null;
        for (const lead of missing) {
          const { payload, externalRef } = buildPushPayload(lead, source.campaignLabel);
          let outcome: Outcome;
          if (opts.dryRun) outcome = { kind: "not_pushed", reason: "Report-only check" };
          else if (!settings.pushMissing) outcome = { kind: "not_pushed", reason: "Adding missing leads is turned off" };
          else {
            try {
              const result = await ingestWebhookEnquiry(payload, externalRef);
              outcome = result.duplicate
                ? { kind: "duplicate", enquiryId: result.enquiry.id }
                : result.merged
                  ? { kind: "merged", enquiryId: result.enquiry.id }
                  : { kind: "created", enquiryId: result.enquiry.id };
              summary.pushed++;
            } catch (err) {
              outcome = { kind: "failed", error: err instanceof Error ? err.message : "unknown error" };
              summary.pushFailed++;
              earliestUnresolved ??= lead;
            }
          }
          missingRows.push({ sheet: source.name, tab: sheet.tabTitle, lead, campaignLabel: payload.campaignLabel, outcome });
        }

        if (!opts.dryRun) {
          // A lead that failed to push must be looked at again next time, so
          // the watermark stops just before it rather than moving past.
          const lastRowNumber = earliestUnresolved
            ? earliestUnresolved.rowNumber - 1
            : Math.max(source.lastRowNumber ?? 0, ...leads.map((l) => l.rowNumber));
          await prisma.sheetCheckSource.update({
            where: { id: source.id },
            data: {
              lastRowNumber,
              lastCheckedAt: earliestUnresolved?.createdAt ?? run.startedAt,
              lastStatus: summary.missing ? "missing" : "ok",
              lastMessage: summary.missing
                ? `${summary.missing} of ${summary.checked} checked were missing` +
                  (summary.pushed ? ` — ${summary.pushed} added` : "") +
                  (summary.pushFailed ? `, ${summary.pushFailed} failed` : "")
                : `All ${summary.checked} checked are in the CRM`,
            },
          });
        }
      } catch (err) {
        summary.error = err instanceof Error ? err.message : "Couldn't read the sheet";
        if (!opts.dryRun) {
          await prisma.sheetCheckSource.update({
            where: { id: source.id },
            data: { lastStatus: "error", lastMessage: summary.error },
          });
        }
      }
    }

    const totals = {
      checked: summaries.reduce((a, s) => a + s.checked, 0),
      missing: missingRows.length,
      pushed: summaries.reduce((a, s) => a + s.pushed, 0),
      pushFailed: summaries.reduce((a, s) => a + s.pushFailed, 0),
      sheetErrors: summaries.filter((s) => s.error).length,
    };
    const status = totals.missing || totals.sheetErrors ? "issues" : "ok";

    let csvKey: string | null = null;
    let csvFilename: string | null = null;
    let csvBuffer: Buffer | null = null;
    if (missingRows.length) {
      csvFilename = `missing-leads-${istStamp(run.startedAt).slice(0, 10)}${opts.dryRun ? "-report-only" : ""}.csv`;
      csvBuffer = Buffer.from(toCsv(CSV_HEADERS, missingRows.map(csvRow)), "utf8");
      csvKey = `reports/sheet-check/${run.id}.csv`;
      await putObjectBuffer(csvKey, csvBuffer, "text/csv");
    }

    let emailedTo: string | null = null;
    let emailError: string | null = null;
    if (!opts.dryRun && status === "issues" && settings.recipients.length) {
      try {
        await emailReport({ settings, summaries, totals, csvBuffer, csvFilename, startedAt: run.startedAt });
        emailedTo = settings.recipients.join(", ");
      } catch (err) {
        emailError = err instanceof Error ? err.message : "send failed";
        logger.error({ err, runId: run.id }, "sheet check: email failed");
      }
    }

    await prisma.sheetCheckRun.update({
      where: { id: run.id },
      data: {
        status,
        checkedCount: totals.checked,
        missingCount: totals.missing,
        pushedCount: totals.pushed,
        pushFailedCount: totals.pushFailed,
        sheetErrors: totals.sheetErrors,
        summary: summaries as unknown as Prisma.InputJsonValue,
        csvKey,
        csvFilename,
        emailedAt: emailedTo ? new Date() : null,
        emailedTo,
        emailError,
        finishedAt: new Date(),
      },
    });
    logger.info({ runId: run.id, ...totals, dryRun: opts.dryRun, trigger: opts.trigger }, "sheet check finished");

    return {
      runId: run.id,
      status,
      ...totals,
      sheets: summaries,
      missingLeads: missingRows.map((m) => ({
        sheet: m.sheet,
        rowNumber: m.lead.rowNumber,
        name: m.lead.fullName,
        receivedAt: m.lead.createdAt?.toISOString() ?? null,
        result: OUTCOME_TEXT[m.outcome.kind] + (m.outcome.kind === "failed" ? `: ${m.outcome.error}` : ""),
      })),
      emailedTo,
      emailError,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sheet check failed";
    await prisma.sheetCheckRun.update({
      where: { id: run.id },
      data: { status: "failed", error: message, finishedAt: new Date() },
    });
    logger.error({ err, runId: run.id }, "sheet check failed");
    throw err;
  } finally {
    await redis.del(LOCK_KEY).catch(() => {});
  }
}

async function emailReport(args: {
  settings: SheetCheckSettingsDTO;
  summaries: SheetSummary[];
  totals: { checked: number; missing: number; pushed: number; pushFailed: number; sheetErrors: number };
  csvBuffer: Buffer | null;
  csvFilename: string | null;
  startedAt: Date;
}): Promise<void> {
  const mailbox = getMailbox("sales");
  if (!mailbox?.configured) throw new Error("The sales mailbox isn't configured");
  const { totals, settings } = args;
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", dateStyle: "medium" }).format(args.startedAt);

  const headline = totals.missing
    ? `${totals.missing} lead${totals.missing === 1 ? "" : "s"} from the lead sheets had not reached the CRM.`
    : "Every lead checked is in the CRM, but some sheets couldn't be read.";
  const action = !totals.missing
    ? ""
    : !settings.pushMissing
      ? "They were NOT added — adding missing leads is turned off in the CRM."
      : `${totals.pushed} ${totals.pushed === 1 ? "was" : "were"} added to the CRM now` +
        (totals.pushFailed ? `; ${totals.pushFailed} could not be added (see the CSV).` : ".");
  const perSheet = args.summaries.map((s) =>
    s.error
      ? `• ${s.name} — couldn't check: ${s.error}`
      : `• ${s.name} — ${s.checked} checked, ${s.missing} missing${s.pushed ? `, ${s.pushed} added` : ""}${s.pushFailed ? `, ${s.pushFailed} failed` : ""}`,
  );

  await sendEmail(mailbox, {
    skipFooter: true,
    to: settings.recipients.join(", "),
    subject: totals.missing
      ? `Trē Wellness — ${totals.missing} lead${totals.missing === 1 ? "" : "s"} missing from the CRM (${date})`
      : `Trē Wellness — lead sheet check couldn't read ${totals.sheetErrors} sheet${totals.sheetErrors === 1 ? "" : "s"} (${date})`,
    text: [
      `Lead sheet check, ${date}`,
      "",
      headline,
      action,
      "",
      "Per sheet:",
      ...perSheet,
      "",
      "Each check covers the last 10 leads in every sheet plus everything added since the previous check.",
      ...(args.csvBuffer ? ["The attached CSV lists every missing lead and what happened to it."] : []),
    ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"),
    attachments: args.csvBuffer && args.csvFilename
      ? [{ filename: args.csvFilename, content: args.csvBuffer, contentType: "text/csv" }]
      : [],
  });
}

/**
 * Called by the cron container once a day. Runs a real check only when the
 * interval has passed since the last successful one; a failed run doesn't
 * count, so it is retried the next day.
 */
export async function tickSheetCheck(now = new Date()): Promise<{ ran: boolean; reason: string; result?: RunResult }> {
  await prisma.sheetCheckSetting.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", lastTickAt: now },
    update: { lastTickAt: now },
  });
  const settings = await getSettings();
  if (!settings.enabled) return { ran: false, reason: "Automatic checks are turned off" };
  // Not set up yet: say so and stop, rather than logging a failed run every
  // day — the page already shows what's missing.
  if (!(await prisma.sheetCheckSource.count({ where: { enabled: true } }))) {
    return { ran: false, reason: "No sheets are set up to check" };
  }
  if (!serviceAccountEmail()) return { ran: false, reason: "Google access isn't set up" };

  const last = await prisma.sheetCheckRun.findFirst({
    where: { dryRun: false, status: { in: ["ok", "issues"] } },
    orderBy: { startedAt: "desc" },
  });
  if (!isDue(last?.startedAt ?? null, settings.intervalDays, now)) {
    return { ran: false, reason: `Not due — last check ${last!.startedAt.toISOString()}, every ${settings.intervalDays} days` };
  }
  const result = await runSheetCheck({ trigger: "schedule", dryRun: false });
  return { ran: true, reason: "Due", result };
}

export async function listRuns(limit = 20) {
  const rows = await prisma.sheetCheckRun.findMany({ orderBy: { startedAt: "desc" }, take: limit });
  return rows.map((r) => ({
    id: r.id,
    trigger: r.trigger,
    dryRun: r.dryRun,
    status: r.status,
    checkedCount: r.checkedCount,
    missingCount: r.missingCount,
    pushedCount: r.pushedCount,
    pushFailedCount: r.pushFailedCount,
    sheetErrors: r.sheetErrors,
    summary: r.summary as unknown as SheetSummary[],
    hasCsv: !!r.csvKey,
    emailedAt: r.emailedAt?.toISOString() ?? null,
    emailedTo: r.emailedTo,
    emailError: r.emailError,
    error: r.error,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }));
}

export async function getRunCsv(id: string): Promise<{ filename: string; buffer: Buffer } | null> {
  const run = await prisma.sheetCheckRun.findUnique({ where: { id } });
  if (!run?.csvKey) return null;
  return { filename: run.csvFilename ?? "missing-leads.csv", buffer: await getObjectBuffer(run.csvKey) };
}

/** When the next scheduled check will run, for the page. */
export async function nextDueAt(): Promise<string | null> {
  const settings = await getSettings();
  if (!settings.enabled) return null;
  const last = await prisma.sheetCheckRun.findFirst({
    where: { dryRun: false, status: { in: ["ok", "issues"] } },
    orderBy: { startedAt: "desc" },
  });
  if (!last) return null;
  return new Date(last.startedAt.getTime() + settings.intervalDays * 86_400_000 - 2 * 3_600_000).toISOString();
}
