import type { WhatsAppNumber, AutoReplyKind } from "@prisma/client";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { sendWhatsAppMessage, sendWhatsAppMedia } from "./whatsapp";
import { tagWhatsAppNumberUsed } from "./whatsapp-number-tag";
import { getObjectBuffer } from "./storage";

/**
 * WhatsApp auto-reply — see prisma/schema.prisma's AutoReply model. Matching
 * and sending live here so both the CRUD API and the inbound webhook
 * (whatsapp/route.ts) share one implementation.
 */

export interface AutoReplyDTO {
  id: string;
  numberId: string;
  kind: AutoReplyKind;
  triggerWord: string | null;
  replyText: string;
  enabled: boolean;
  activeFromMin: number | null;
  activeToMin: number | null;
  /** Optional library file sent along with the reply. */
  attachmentDocumentId: string | null;
  attachment: { id: string; filename: string; mimeType: string; sizeBytes: number } | null;
  createdAt: string;
  updatedAt: string;
}

interface AutoReplyRow {
  id: string;
  numberId: string;
  kind: AutoReplyKind;
  triggerWord: string | null;
  replyText: string;
  enabled: boolean;
  activeFromMin: number | null;
  activeToMin: number | null;
  attachmentDocumentId: string | null;
  attachmentDocument?: { id: string; filename: string; mimeType: string; sizeBytes: number } | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDTO(row: AutoReplyRow): AutoReplyDTO {
  return {
    id: row.id,
    numberId: row.numberId,
    kind: row.kind,
    triggerWord: row.triggerWord,
    replyText: row.replyText,
    enabled: row.enabled,
    activeFromMin: row.activeFromMin,
    activeToMin: row.activeToMin,
    attachmentDocumentId: row.attachmentDocumentId,
    attachment: row.attachmentDocument ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Whether a daily IST window is currently open. Both bounds null = always
 * on. from > to wraps midnight (1320→360 = 10pm–6am). A half-set window
 * (only one bound) is treated as always-on rather than guessing.
 * IST has no DST, so a fixed +330min offset from UTC is exact year-round.
 */
export function isWithinSchedule(
  activeFromMin: number | null,
  activeToMin: number | null,
  now: Date = new Date(),
): boolean {
  if (activeFromMin == null || activeToMin == null) return true;
  const istMin = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
  return activeFromMin <= activeToMin
    ? istMin >= activeFromMin && istMin < activeToMin
    : istMin >= activeFromMin || istMin < activeToMin;
}

/** Hydrated on every read/write so the settings UI can name the file. */
const ATTACHMENT_INCLUDE = {
  attachmentDocument: { select: { id: true, filename: true, mimeType: true, sizeBytes: true } },
} as const;

export async function listAutoReplies(numberId?: string): Promise<AutoReplyDTO[]> {
  const rows = await prisma.autoReply.findMany({
    where: numberId ? { numberId } : undefined,
    orderBy: [{ numberId: "asc" }, { createdAt: "asc" }],
    include: ATTACHMENT_INCLUDE,
  });
  return rows.map(toDTO);
}

export async function createAutoReply(input: {
  numberId: string;
  kind?: AutoReplyKind;
  triggerWord?: string | null;
  replyText: string;
  activeFromMin?: number | null;
  activeToMin?: number | null;
  attachmentDocumentId?: string | null;
  createdBy: string;
}): Promise<AutoReplyDTO> {
  const row = await prisma.autoReply.create({
    include: ATTACHMENT_INCLUDE,
    data: {
      numberId: input.numberId,
      kind: input.kind ?? "trigger",
      // Welcome replies are event-driven (new number), never text-matched.
      triggerWord: input.kind === "welcome" ? null : input.triggerWord?.trim() || null,
      replyText: input.replyText,
      activeFromMin: input.activeFromMin ?? null,
      activeToMin: input.activeToMin ?? null,
      attachmentDocumentId: input.attachmentDocumentId ?? null,
      createdBy: input.createdBy,
    },
  });
  return toDTO(row);
}

export async function updateAutoReply(
  id: string,
  input: {
    triggerWord?: string | null;
    replyText?: string;
    enabled?: boolean;
    activeFromMin?: number | null;
    activeToMin?: number | null;
    attachmentDocumentId?: string | null;
  },
): Promise<AutoReplyDTO> {
  const row = await prisma.autoReply.update({
    where: { id },
    include: ATTACHMENT_INCLUDE,
    data: {
      ...(input.triggerWord !== undefined && { triggerWord: input.triggerWord?.trim() || null }),
      ...(input.replyText !== undefined && { replyText: input.replyText }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.activeFromMin !== undefined && { activeFromMin: input.activeFromMin }),
      ...(input.activeToMin !== undefined && { activeToMin: input.activeToMin }),
      ...(input.attachmentDocumentId !== undefined && { attachmentDocumentId: input.attachmentDocumentId }),
    },
  });
  return toDTO(row);
}

export async function deleteAutoReply(id: string): Promise<void> {
  await prisma.autoReply.delete({ where: { id } });
}

/**
 * Picks which auto-reply (if any) a given inbound message body should
 * trigger. A trigger word matches as a case-insensitive substring anywhere
 * in the body — checked in creation order, first match wins; a blank
 * triggerWord is a catch-all, only used once nothing with a real trigger
 * word matched. Pure function (no I/O) so it's unit-testable without a DB.
 */
export function matchAutoReply<T extends { triggerWord: string | null; enabled: boolean }>(
  autoReplies: T[],
  body: string,
): T | null {
  const normalizedBody = body.toLowerCase();
  const enabled = autoReplies.filter((a) => a.enabled);
  const withTrigger = enabled.filter((a) => a.triggerWord?.trim());
  const catchAll = enabled.filter((a) => !a.triggerWord?.trim());

  const specific = withTrigger.find((a) => normalizedBody.includes(a.triggerWord!.trim().toLowerCase()));
  return specific ?? catchAll[0] ?? null;
}

// Don't fire a second auto-reply to the same guest on the same number within
// this window — nothing in the codebase throttled automated sends before
// this, and without it a guest sending several messages in quick succession
// (or two auto-reply-enabled numbers messaging each other) would get spammed.
const COOLDOWN_SEC = 60;

/**
 * Called from the inbound WhatsApp webhook for every genuine guest message
 * (never for fromMe/internal traffic — the caller filters those out first).
 * Best-effort: any failure is logged and swallowed, never thrown, so it can
 * never break inbound message storage.
 *
 * `isNewGuest` = this very message created the guest record (their number
 * wasn't in the database before it). When this number has an enabled
 * welcome reply, that's what a new guest gets — INSTEAD of any trigger
 * reply, so their first contact isn't answered twice.
 */
export async function maybeSendAutoReply(params: {
  number: WhatsAppNumber;
  guestId: string;
  enquiryId?: string | null;
  phone: string;
  body: string;
  isNewGuest?: boolean;
}): Promise<void> {
  const { number, guestId, enquiryId, phone, body, isNewGuest } = params;
  try {
    const rows = await prisma.autoReply.findMany({
      where: { numberId: number.id, enabled: true },
      orderBy: { createdAt: "asc" },
      include: { attachmentDocument: true },
    });
    // Schedule gate applies uniformly — an out-of-window welcome doesn't fall
    // back to a trigger reply either; it's simply quiet hours for that rule.
    const candidates = rows.filter((a) => isWithinSchedule(a.activeFromMin, a.activeToMin));
    const welcome = isNewGuest ? candidates.find((a) => a.kind === "welcome") ?? null : null;
    const match = welcome ?? matchAutoReply(candidates.filter((a) => a.kind === "trigger"), body);
    if (!match) return;

    const recentlyReplied = await prisma.activity.findFirst({
      where: {
        guestId,
        actorSub: "whatsapp-autoreply",
        createdAt: { gte: new Date(Date.now() - COOLDOWN_SEC * 1000) },
        metadata: { path: ["numberId"], equals: number.id },
      },
      select: { id: true },
    });
    if (recentlyReplied) return;

    const base = {
      guestId,
      enquiryId: enquiryId ?? null,
      mailboxId: number.instanceName,
      channel: "whatsapp" as const,
      direction: "outbound" as const,
      body: match.replyText,
      fromEmail: number.phoneNumber,
      toEmail: phone,
      // Recorded on the message so the thread renders the file, same as any
      // other attachment.
      attachmentDocumentId: match.attachmentDocumentId,
    };

    try {
      const doc = match.attachmentDocument;
      // With a file, the reply text rides along as the media caption rather
      // than being sent as a second message — one notification, not two.
      const res = doc
        ? await sendWhatsAppMedia(number, phone, {
            mimeType: doc.mimeType,
            fileName: doc.filename,
            base64: (await getObjectBuffer(doc.storageKey)).toString("base64"),
            caption: match.replyText,
          })
        : await sendWhatsAppMessage(number, phone, match.replyText);
      await prisma.message.create({ data: { ...base, externalId: res.externalId, status: "sent" } });
      await tagWhatsAppNumberUsed(guestId, number.phoneNumber);
    } catch (err) {
      logger.error({ err, guestId, numberId: number.id }, "whatsapp auto-reply send failed");
      await prisma.message.create({
        data: { ...base, status: "failed", errorDetail: err instanceof Error ? err.message : "send failed" },
      });
      return;
    }

    await prisma.activity.create({
      data: {
        guestId,
        enquiryId: enquiryId ?? null,
        actorSub: "whatsapp-autoreply",
        actorRole: "system",
        actorName: "Auto-reply",
        actionType: "message_sent",
        metadata: {
          channel: "whatsapp",
          instance: number.instanceName,
          numberId: number.id,
          numberLabel: number.label,
          line: number.phoneNumber,
          autoReplyId: match.id,
          to: phone,
        },
      },
    });
  } catch (err) {
    logger.error({ err, guestId, numberId: number.id }, "whatsapp auto-reply failed");
  }
}
