import type { WhatsAppNumber } from "@prisma/client";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { sendWhatsAppMessage } from "./whatsapp";

/**
 * WhatsApp auto-reply — see prisma/schema.prisma's AutoReply model. Matching
 * and sending live here so both the CRUD API and the inbound webhook
 * (whatsapp/route.ts) share one implementation.
 */

export interface AutoReplyDTO {
  id: string;
  numberId: string;
  triggerWord: string | null;
  replyText: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

function toDTO(row: {
  id: string;
  numberId: string;
  triggerWord: string | null;
  replyText: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): AutoReplyDTO {
  return {
    id: row.id,
    numberId: row.numberId,
    triggerWord: row.triggerWord,
    replyText: row.replyText,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listAutoReplies(numberId?: string): Promise<AutoReplyDTO[]> {
  const rows = await prisma.autoReply.findMany({
    where: numberId ? { numberId } : undefined,
    orderBy: [{ numberId: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toDTO);
}

export async function createAutoReply(input: {
  numberId: string;
  triggerWord?: string | null;
  replyText: string;
  createdBy: string;
}): Promise<AutoReplyDTO> {
  const row = await prisma.autoReply.create({
    data: {
      numberId: input.numberId,
      triggerWord: input.triggerWord?.trim() || null,
      replyText: input.replyText,
      createdBy: input.createdBy,
    },
  });
  return toDTO(row);
}

export async function updateAutoReply(
  id: string,
  input: { triggerWord?: string | null; replyText?: string; enabled?: boolean },
): Promise<AutoReplyDTO> {
  const row = await prisma.autoReply.update({
    where: { id },
    data: {
      ...(input.triggerWord !== undefined && { triggerWord: input.triggerWord?.trim() || null }),
      ...(input.replyText !== undefined && { replyText: input.replyText }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
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
 */
export async function maybeSendAutoReply(params: {
  number: WhatsAppNumber;
  guestId: string;
  enquiryId?: string | null;
  phone: string;
  body: string;
}): Promise<void> {
  const { number, guestId, enquiryId, phone, body } = params;
  try {
    const candidates = await prisma.autoReply.findMany({
      where: { numberId: number.id, enabled: true },
      orderBy: { createdAt: "asc" },
    });
    const match = matchAutoReply(candidates, body);
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
    };

    try {
      const res = await sendWhatsAppMessage(number, phone, match.replyText);
      await prisma.message.create({ data: { ...base, externalId: res.externalId, status: "sent" } });
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
          autoReplyId: match.id,
          to: phone,
        },
      },
    });
  } catch (err) {
    logger.error({ err, guestId, numberId: number.id }, "whatsapp auto-reply failed");
  }
}
