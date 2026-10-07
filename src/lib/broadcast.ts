import { prisma } from "./prisma";
import { logger } from "./logger";
import { tagBroadcastFailure } from "./broadcast-failed-tag";
import { sendWhatsAppMessage, sendWhatsAppMedia } from "./whatsapp";
import { tagWhatsAppNumberUsed } from "./whatsapp-number-tag";
import {
  listMessageTemplates,
  marketingApiEnabled,
  sendTemplateMessage,
  uploadMedia,
  type TemplateSendComponent,
} from "./whatsapp-cloud-api";
import { getObjectBuffer } from "./storage";
import { templateBodyParams } from "./whatsapp-template";
import { fillTemplateBody } from "./whatsapp-template-fill";
import { personalizeTemplate } from "./message-templates";
import { materializeFollowUp } from "./broadcast-followup";
import type { BroadcastJob, BroadcastStatus, Prisma } from "@prisma/client";

const ACTIVE_STATUSES: BroadcastStatus[] = ["queued", "running"];

export interface StartBroadcastInput {
  message: string;
  imageDocumentId?: string | null;
  guestIds: string[];
  delaySec: number;
  numberId?: string | null;
  createdBySub: string;
  /** Slugified tag applied to a lead when that guest replies — see lib/reply-tag.ts. */
  replyTag?: string | null;
  /** Hold the send until this time. Null/omitted = start immediately. */
  scheduledAt?: Date | null;
  /** Parent campaign this follows up; its audience is resolved at start. */
  followUpOfJobId?: string | null;
  /** Only guests whose reply contained this text (i.e. tapped that button). */
  followUpTrigger?: string | null;
  /** Skip anyone contacted within this many hours. In rolling mode this is
   *  also the per-guest delay — see followUpRollingUntil. */
  followUpQuietHours?: number | null;
  /** Chase each guest on their own clock until this time, instead of sending
   *  one batch. Omitted = the original one-shot behaviour. */
  followUpRollingUntil?: Date | null;
  /** Cloud API numbers only — send this approved template instead of
   *  `message` (free text isn't allowed outside an open 24h window).
   *  `bodyParamNames` is set only for a NAMED-parameter template (e.g.
   *  {{customer_name}}) — parallel array to bodyParams, giving each value
   *  the placeholder name Meta's API requires; omitted/null for a
   *  positional template ({{1}}, {{2}}), which uses array order alone. */
  template?: { name: string; language: string; bodyParams: string[]; bodyParamNames?: string[] | null } | null;
}

/** The one job currently queued or running, if any — used to enforce "one at a time" and for progress polling. */
/**
 * Jobs that are runnable NOW. A job queued behind a future `scheduledAt` is
 * deliberately excluded: a follow-up sitting 48 hours out must not count as
 * "a broadcast is already running" and block every send for two days, and it
 * shouldn't drive the live progress bar either.
 */
function dueNow(): Prisma.BroadcastJobWhereInput {
  return {
    status: { in: ACTIVE_STATUSES },
    OR: [{ scheduledAt: null }, { scheduledAt: { lte: new Date() } }],
  };
}

export async function getActiveBroadcast(): Promise<BroadcastJob | null> {
  return prisma.broadcastJob.findFirst({
    where: dueNow(),
    orderBy: { createdAt: "desc" },
  });
}

/** Every job running right now. Plural since broadcasts stopped being
 *  one-at-a-time — the Guests page shows them all rather than pretending the
 *  newest is the only one. */
export async function listActiveBroadcasts(): Promise<BroadcastJob[]> {
  return prisma.broadcastJob.findMany({
    where: dueNow(),
    orderBy: { createdAt: "asc" },
  });
}

/** Queued jobs still waiting for their scheduled time — shown as "scheduled". */
export async function listScheduledBroadcasts(): Promise<BroadcastJob[]> {
  return prisma.broadcastJob.findMany({
    where: { status: "queued", scheduledAt: { gt: new Date() }, deletedAt: null },
    orderBy: { scheduledAt: "asc" },
  });
}

/**
 * Whether a job may use Meta's Marketing Messages API.
 *
 * Meta accepts only MARKETING templates on /marketing_messages and rejects
 * UTILITY / AUTHENTICATION / SERVICE outright, so this fails closed: anything
 * other than a confirmed MARKETING category — including a null category from
 * a failed lookup — stays on the Cloud API path it used before.
 */
/**
 * The template as this guest will read it: approved wording, placeholders
 * filled with the job's parameters, personalised the same way the parameters
 * themselves are when they are sent to Meta.
 */
export function renderTemplateForGuest(
  job: { templateBody: string | null; templateBodyParams: unknown },
  fullName: string,
  gender: string | null,
): string | null {
  if (!job.templateBody) return null;
  const raw = (job.templateBodyParams as string[] | null) ?? [];
  const { names } = templateBodyParams({ components: [{ type: "BODY", text: job.templateBody }] });
  return fillTemplateBody(
    job.templateBody,
    names,
    names.map((_, i) => personalize(raw[i] ?? "", fullName, gender)),
  );
}

export function shouldUseMarketingApi(templateCategory: string | null, enabled: boolean): boolean {
  return enabled && templateCategory === "MARKETING";
}

export async function startBroadcast(input: StartBroadcastInput): Promise<BroadcastJob> {
  // Broadcasts used to be one-at-a-time: starting a second while one was in
  // flight threw, so a 3,000-recipient send blocked the console for the best
  // part of an hour. They now run side by side — the worker advances every
  // due job each tick — and progress is followed on the Broadcast Status
  // page rather than by waiting on the compose dialog.
  // Only a Cloud API template send ever needs a HEADER image — Baileys
  // broadcasts (no `template`) send imageDocumentId inline per-recipient
  // instead (see sendOne). Uploaded once here, reused for every recipient.
  let headerMediaId: string | null = null;
  let templateCategory: string | null = null;
  // The words the template actually says, kept with the job so every message
  // can store what the guest read instead of the template's name.
  let templateBody: string | null = null;
  if (input.template) {
    const number = input.numberId
      ? await prisma.whatsAppNumber.findUnique({ where: { id: input.numberId } })
      : await prisma.whatsAppNumber.findFirst({
          where: { status: "connected" },
          orderBy: [{ isDefault: "desc" }, { label: "asc" }],
        });
    if (number?.integration === "cloud_api" && number.metaPhoneNumberId && number.metaAccessToken) {
      // Resolved from Meta rather than taken from the request: the category
      // decides which endpoint the job sends over, and only MARKETING may use
      // /marketing_messages, so a client-supplied value would be a way to
      // push the wrong template type at it and have every send rejected.
      if (number.wabaId) {
        try {
          const templates = await listMessageTemplates(number.wabaId, number.metaAccessToken);
          const approved = templates.find(
            (t) => t.name === input.template!.name && t.language === input.template!.language,
          );
          templateCategory = approved?.category ?? null;
          templateBody = approved?.components.find((c) => c.type === "BODY")?.text ?? null;
        } catch (err) {
          // Non-fatal: an unknown category just means this job stays on the
          // Cloud API path, which is the pre-existing behaviour.
          logger.warn({ err, template: input.template.name }, "broadcast: template category lookup failed");
        }
      }
      if (input.imageDocumentId) {
        const doc = await prisma.document.findUnique({ where: { id: input.imageDocumentId } });
        if (doc) {
          const buffer = await getObjectBuffer(doc.storageKey);
          const uploaded = await uploadMedia(number.metaPhoneNumberId, number.metaAccessToken, buffer, doc.mimeType, doc.filename);
          headerMediaId = uploaded.mediaId;
        }
      }
    }
  }

  // Decided once, at creation, so every recipient in a job takes the same
  // path — a job split across both endpoints would make its delivery numbers
  // impossible to attribute.
  const usedMarketingApi = shouldUseMarketingApi(templateCategory, marketingApiEnabled());

  return prisma.broadcastJob.create({
    data: {
      status: "queued",
      createdBySub: input.createdBySub,
      message: input.message,
      imageDocumentId: input.imageDocumentId ?? null,
      headerMediaId,
      numberId: input.numberId ?? null,
      delaySec: input.delaySec,
      guestIds: input.guestIds,
      totalCount: input.guestIds.length,
      templateName: input.template?.name ?? null,
      templateLanguage: input.template?.language ?? null,
      templateCategory,
      usedMarketingApi,
      replyTag: input.replyTag ?? null,
      scheduledAt: input.scheduledAt ?? null,
      followUpOfJobId: input.followUpOfJobId ?? null,
      followUpTrigger: input.followUpTrigger ?? null,
      followUpQuietHours: input.followUpQuietHours ?? null,
      followUpRollingUntil: input.followUpRollingUntil ?? null,
      templateBodyParams: input.template ? input.template.bodyParams : undefined,
      templateBody,
      templateParamNames: input.template?.bodyParamNames?.length ? input.template.bodyParamNames : undefined,
    },
  });
}

export async function cancelBroadcast(id: string): Promise<void> {
  await prisma.broadcastJob.updateMany({
    where: { id, status: { in: ACTIVE_STATUSES } },
    data: { status: "cancelled", completedAt: new Date() },
  });
}

/** Personalizes the template's {name}/{salutation} tokens with the guest's
 *  first name and Mr./Ms. (from gender), so a batch doesn't read as an
 *  obvious form-letter blast. */
export function personalize(template: string, fullName: string, gender?: string | null): string {
  return personalizeTemplate(template, { name: fullName, gender });
}

let ticking = false;

/** How often a rolling follow-up re-checks who has become due. Small enough
 *  that "48 hours after our last message" lands within the hour, large enough
 *  that a two-week chase is a few hundred audience queries, not tens of
 *  thousands. */
const ROLLING_RECHECK_MIN = 15;

/** Park a rolling follow-up until its next check, or finish it if its window
 *  has closed. Returns true when the job was parked (caller should stop). */
async function parkOrFinishRolling(job: BroadcastJob): Promise<boolean> {
  const until = job.followUpRollingUntil;
  if (!until || until.getTime() <= Date.now()) return false;
  await prisma.broadcastJob.update({
    where: { id: job.id },
    data: {
      status: "queued",
      cursor: 0,
      guestIds: [],
      // Held in the future so dueNow() skips it, which also keeps it out of
      // getActiveBroadcast() — a job that spends two weeks waiting must not
      // read as "a broadcast is already running" and block every other send.
      scheduledAt: new Date(Date.now() + ROLLING_RECHECK_MIN * 60 * 1000),
    },
  });
  return true;
}

/**
 * Called every ~2s from instrumentation-node.ts. Advances EVERY runnable job
 * by at most one message, each paced by its own delaySec (tracked via
 * lastSentAt) so a burst of ticks after a restart can't blow past the
 * configured rate. Guards against overlapping runs the same way pollInbound()
 * does.
 *
 * Jobs progress side by side rather than strictly in turn: two campaigns
 * started a minute apart both make progress instead of the second waiting out
 * the first. Oldest first, so a job can't be starved by newer ones arriving.
 */
export async function tickBroadcast(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const due = await prisma.broadcastJob.findMany({
      where: dueNow(),
      orderBy: { createdAt: "asc" },
      take: MAX_PARALLEL_JOBS,
    });
    for (const j of due) {
      // One job failing must not stop the others — its own errors are already
      // recorded per recipient, but an unexpected throw here would otherwise
      // end the tick and stall every job behind it.
      await advanceJob(j).catch((err) =>
        logger.error({ err, jobId: j.id }, "broadcast: job tick failed"),
      );
    }
  } finally {
    ticking = false;
  }
}

/**
 * How many jobs the worker will advance in a single tick. Each contributes at
 * most one message per tick, so this is also the ceiling on send rate:
 * MAX_PARALLEL_JOBS messages per ~2s across everything running. Anything past
 * it simply waits for the next tick, oldest first.
 */
const MAX_PARALLEL_JOBS = 8;

async function advanceJob(initial: BroadcastJob): Promise<void> {
  let job = initial;

  if (job.status === "queued") {
    // A follow-up's recipients are decided HERE, not when it was scheduled —
    // everyone who replied or called during the wait drops out. Resolved
    // before the status flips so a crash mid-resolve just retries.
    if (job.followUpOfJobId) {
      const hasRecipients = await materializeFollowUp(job.id, job.followUpOfJobId, {
        trigger: job.followUpTrigger,
        quietHours: job.followUpQuietHours ?? undefined,
        rolling: Boolean(job.followUpRollingUntil),
      });
      if (!hasRecipients) {
        // Nobody due YET is the normal state of a rolling job for most of
        // its life — it must go back to waiting, not finish.
        if (await parkOrFinishRolling(job)) return;
        await prisma.broadcastJob.update({
          where: { id: job.id },
          data: { status: "completed", completedAt: new Date(), totalCount: 0 },
        });
        logger.info({ jobId: job.id }, "broadcast follow-up: everyone had responded, nothing to send");
        return;
      }
    }
    // Re-read via the update's own return value, NOT the row fetched above:
    // materializeFollowUp has just rewritten guestIds/totalCount in the
    // database, and the stale in-memory copy still holds the empty list a
    // follow-up is created with. Without this the cursor check below sees
    // `0 >= 0`, completes the job on the spot, and every recipient sits at
    // "Pending" having never been messaged.
    job = await prisma.broadcastJob.update({
      where: { id: job.id },
      data: { status: "running" },
    });
  }

  if (job.lastSentAt && Date.now() - job.lastSentAt.getTime() < job.delaySec * 1000) return;

  if (job.cursor >= job.guestIds.length) {
    // This batch is done. A rolling job goes back to waiting for the next
    // people to come due; a one-shot job is finished for good.
    if (await parkOrFinishRolling(job)) return;
    await prisma.broadcastJob.update({
      where: { id: job.id },
      data: { status: "completed", completedAt: new Date() },
    });
    return;
  }

  const guestId = job.guestIds[job.cursor];
  await sendOne(job, guestId).catch((err) =>
    logger.error({ err, jobId: job.id, guestId }, "broadcast: send failed"),
  );
}

async function sendOne(job: BroadcastJob, guestId: string): Promise<void> {
  const guest = await prisma.guest.findFirst({
    where: { id: guestId, deletedAt: null },
    select: { id: true, fullName: true, phone: true, gender: true },
  });

  const number = job.numberId
    ? await prisma.whatsAppNumber.findUnique({ where: { id: job.numberId } })
    : await prisma.whatsAppNumber.findFirst({
        where: { status: "connected" },
        orderBy: [{ isDefault: "desc" }, { label: "asc" }],
      });

  if (!guest?.phone) {
    await recordResult(job, guestId, false, "No phone number on file");
    return;
  }
  if (!number || number.status !== "connected") {
    await recordResult(job, guestId, false, "No connected WhatsApp number");
    return;
  }

  const isCloudApiTemplate = number.integration === "cloud_api" && job.templateName;
  const text = isCloudApiTemplate
    ? job.templateName!
    : personalize(job.message, guest.fullName, guest.gender);

  // What this guest will actually read, for the thread. Falls back to the
  // template's name for jobs created before the body was captured.
  const templateText = isCloudApiTemplate
    ? renderTemplateForGuest(job, guest.fullName, guest.gender) ?? `[template: ${job.templateName}]`
    : null;

  let attachment: { mimeType: string; fileName: string; base64: string } | null = null;
  if (job.imageDocumentId && !isCloudApiTemplate) {
    const doc = await prisma.document.findUnique({ where: { id: job.imageDocumentId } });
    if (doc) {
      const buffer = await getObjectBuffer(doc.storageKey);
      attachment = { mimeType: doc.mimeType, fileName: doc.filename, base64: buffer.toString("base64") };
    }
  }

  const base = {
    guestId: guest.id,
    mailboxId: number.instanceName,
    channel: "whatsapp" as const,
    direction: "outbound" as const,
    body: isCloudApiTemplate ? templateText! : text,
    metaTemplateName: isCloudApiTemplate ? job.templateName : null,
    fromEmail: number.phoneNumber,
    toEmail: guest.phone,
    broadcastJobId: job.id,
    // Stamped per message so a reply can be attributed without walking back
    // to the job — see lib/reply-tag.ts.
    replyTag: job.replyTag,
  };

  try {
    let res: { externalId: string | null };
    if (isCloudApiTemplate) {
      if (!number.metaPhoneNumberId || !number.metaAccessToken) {
        throw new Error("This number is missing its Cloud API credentials");
      }
      const rawParams = (job.templateBodyParams as string[] | null) ?? [];
      const paramNames = job.templateParamNames as string[] | null;
      const components: TemplateSendComponent[] = [];
      if (job.headerMediaId) {
        components.push({ type: "header", parameters: [{ type: "image", image: { id: job.headerMediaId } }] });
      }
      if (rawParams.length) {
        components.push({
          type: "body",
          parameters: rawParams.map((p, i) => ({
            type: "text",
            text: personalize(p, guest.fullName, guest.gender),
            ...(paramNames?.[i] ? { parameter_name: paramNames[i] } : {}),
          })),
        });
      }
      res = await sendTemplateMessage(
        number.metaPhoneNumberId,
        number.metaAccessToken,
        guest.phone,
        job.templateName!,
        job.templateLanguage ?? "en_US",
        components,
        // Fixed at job creation — see startBroadcast. Deliberately not
        // re-evaluated per recipient, so flipping the env mid-run can't
        // split one job across both endpoints.
        job.usedMarketingApi,
      );
    } else if (attachment) {
      res = await sendWhatsAppMedia(number, guest.phone, { ...attachment, caption: text });
    } else {
      res = await sendWhatsAppMessage(number, guest.phone, text);
    }
    await prisma.message.create({ data: { ...base, externalId: res.externalId, status: "sent" } });
    await tagWhatsAppNumberUsed(guest.id, number.phoneNumber);
    await recordResult(job, guestId, true, null);
  } catch (err) {
    const errorDetail = err instanceof Error ? err.message : "send failed";
    await prisma.message.create({ data: { ...base, status: "failed", errorDetail } });
    await recordResult(job, guestId, false, errorDetail);
  }
}

async function recordResult(
  job: BroadcastJob,
  guestId: string,
  success: boolean,
  error: string | null,
): Promise<void> {
  const errors = success
    ? (job.errors as { guestId: string; error: string }[])
    : [...(job.errors as { guestId: string; error: string }[]), { guestId, error: error ?? "Unknown error" }];
  await prisma.broadcastJob.update({
    where: { id: job.id },
    data: {
      cursor: job.cursor + 1,
      sentCount: success ? job.sentCount + 1 : job.sentCount,
      failedCount: success ? job.failedCount : job.failedCount + 1,
      lastSentAt: new Date(),
      errors,
    },
  });

  // Flag the guest for the re-send worklist. This covers only the failures
  // we can see synchronously — no phone on file, no connected number, the
  // send call itself throwing. The far commoner case (WhatsApp accepted it,
  // then delivery failed) has no error to catch here and is tagged later
  // off the status webhook instead; see lib/broadcast-failed-tag.ts. Note
  // the success branch deliberately does NOT clear the tag: "sent" only
  // means it left us, and that is precisely the state that goes on to fail.
  if (!success) await tagBroadcastFailure(guestId);
}
