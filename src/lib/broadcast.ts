import { prisma } from "./prisma";
import { logger } from "./logger";
import { sendWhatsAppMessage, sendWhatsAppMedia } from "./whatsapp";
import {
  listMessageTemplates,
  marketingApiEnabled,
  sendTemplateMessage,
  uploadMedia,
  type TemplateSendComponent,
} from "./whatsapp-cloud-api";
import { getObjectBuffer } from "./storage";
import { personalizeTemplate } from "./message-templates";
import type { BroadcastJob, BroadcastStatus } from "@prisma/client";

const ACTIVE_STATUSES: BroadcastStatus[] = ["queued", "running"];

export interface StartBroadcastInput {
  message: string;
  imageDocumentId?: string | null;
  guestIds: string[];
  delaySec: number;
  numberId?: string | null;
  createdBySub: string;
  /** Cloud API numbers only — send this approved template instead of
   *  `message` (free text isn't allowed outside an open 24h window).
   *  `bodyParamNames` is set only for a NAMED-parameter template (e.g.
   *  {{customer_name}}) — parallel array to bodyParams, giving each value
   *  the placeholder name Meta's API requires; omitted/null for a
   *  positional template ({{1}}, {{2}}), which uses array order alone. */
  template?: { name: string; language: string; bodyParams: string[]; bodyParamNames?: string[] | null } | null;
}

/** The one job currently queued or running, if any — used to enforce "one at a time" and for progress polling. */
export async function getActiveBroadcast(): Promise<BroadcastJob | null> {
  return prisma.broadcastJob.findFirst({
    where: { status: { in: ACTIVE_STATUSES } },
    orderBy: { createdAt: "desc" },
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
export function shouldUseMarketingApi(templateCategory: string | null, enabled: boolean): boolean {
  return enabled && templateCategory === "MARKETING";
}

export async function startBroadcast(input: StartBroadcastInput): Promise<BroadcastJob> {
  const active = await getActiveBroadcast();
  if (active) {
    throw new Error("A broadcast is already running. Wait for it to finish or cancel it first.");
  }

  // Only a Cloud API template send ever needs a HEADER image — Baileys
  // broadcasts (no `template`) send imageDocumentId inline per-recipient
  // instead (see sendOne). Uploaded once here, reused for every recipient.
  let headerMediaId: string | null = null;
  let templateCategory: string | null = null;
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
          templateCategory =
            templates.find(
              (t) => t.name === input.template!.name && t.language === input.template!.language,
            )?.category ?? null;
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
      templateBodyParams: input.template ? input.template.bodyParams : undefined,
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

/**
 * Called every ~2s from instrumentation-node.ts. Sends at most one message
 * per tick, paced by the job's own delaySec (tracked via lastSentAt) so a
 * burst of ticks after a restart can't blow past the configured rate.
 * Guards against overlapping runs the same way pollInbound() does.
 */
export async function tickBroadcast(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const job = await prisma.broadcastJob.findFirst({
      where: { status: { in: ACTIVE_STATUSES } },
      orderBy: { createdAt: "asc" },
    });
    if (!job) return;

    if (job.status === "queued") {
      await prisma.broadcastJob.update({ where: { id: job.id }, data: { status: "running" } });
    }

    if (job.lastSentAt && Date.now() - job.lastSentAt.getTime() < job.delaySec * 1000) return;

    if (job.cursor >= job.guestIds.length) {
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
  } finally {
    ticking = false;
  }
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
    body: isCloudApiTemplate ? `[template: ${job.templateName}]` : text,
    fromEmail: number.phoneNumber,
    toEmail: guest.phone,
    broadcastJobId: job.id,
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
}
