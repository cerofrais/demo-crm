/**
 * POST /api/webhooks/whatsapp — Evolution API's global webhook target.
 * Public endpoint (no session): guarded by a shared secret query param
 * instead of a body signature, since Evolution's own signing support varies
 * by version — same reasoning as the enquiry-form webhook's HMAC, just a
 * simpler scheme here since we control both sides (our own docker-compose).
 *
 * Handles:
 *   messages.upsert    — 1:1 chats only. Inbound (fromMe=false) resolves the
 *                         guest/lead by phone, auto-creating one for an
 *                         unknown sender (mirrors inbound email). Outbound
 *                         (fromMe=true) — a message sent from the linked
 *                         phone's native WhatsApp app rather than through the
 *                         CRM — is synced onto an EXISTING conversation only;
 *                         it never creates a new lead, so the chat stays
 *                         consistent regardless of which side sends from.
 *                         (Messages the CRM itself sends via
 *                         /api/messages/whatsapp are already stored at send
 *                         time and are skipped here by the externalId
 *                         dup-check — this only fills in the gap where a rep
 *                         replies from their phone instead. Genuine inbound
 *                         also runs through maybeSendAutoReply() — see
 *                         lib/whatsapp-autoreply.ts.)
 *   connection.update   — keeps WhatsAppNumber.status in sync if a number
 *                         drops/reconnects outside the admin page.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { buildStorageKey, putObjectBuffer } from "@/lib/storage";
import { getMediaBase64, getConnectionState } from "@/lib/whatsapp-admin";
import {
  fromWhatsAppJid,
  resolveGuestByPhone,
  isInternalPhone,
  detectInboundMedia,
  describeInboundMedia,
  describeNonMediaMessage,
  quotedMessageId,
  applyWhatsAppStatusUpdate,
  type WaMessageContent,
} from "@/lib/whatsapp";
import { maybeSendAutoReply } from "@/lib/whatsapp-autoreply";

export const dynamic = "force-dynamic";

function secretOk(req: NextRequest): boolean {
  const provided = req.nextUrl.searchParams.get("secret") ?? "";
  const expected = env.WHATSAPP_WEBHOOK_SECRET;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface UpsertData {
  key?: { remoteJid?: string; remoteJidAlt?: string; fromMe?: boolean; id?: string };
  pushName?: string;
  message?: WaMessageContent;
}

async function handleMessagesUpsert(instanceName: string, data: UpsertData) {
  const messageId = data.key?.id;
  const rawJid = data.key?.remoteJid;
  // WhatsApp's newer privacy "LID" system reports some contacts' key.remoteJid
  // as `<id>@lid` instead of `<phone>@s.whatsapp.net`; the real phone-based
  // JID is still available in remoteJidAlt. Resolve it before the group-chat
  // filter below, or these messages look like a group and get silently
  // dropped even though they're an ordinary 1:1 chat.
  const jid = rawJid?.endsWith("@lid") ? (data.key?.remoteJidAlt ?? rawJid) : rawJid;
  if (!jid || !messageId || !jid.endsWith("@s.whatsapp.net")) return; // unresolvable jid, or a real group chat

  const number = await prisma.whatsAppNumber.findUnique({ where: { instanceName } });
  if (!number) {
    logger.warn({ instanceName }, "whatsapp webhook: unknown instance");
    return;
  }

  const dup = await prisma.message.findFirst({ where: { channel: "whatsapp", externalId: messageId } });
  if (dup) return; // webhook retry, or the echo of a message we already stored via our own send API

  const phone = fromWhatsAppJid(jid);
  const fromMe = data.key?.fromMe === true;

  // A staff member's personal number (or one of our own connected business
  // numbers) on the other end — never a real guest. Most commonly happens
  // when someone pairs their own phone as a WhatsApp Number for testing;
  // don't let that traffic get onboarded as a lead. See isInternalPhone().
  if (await isInternalPhone(phone)) {
    logger.info({ instanceName, phone, fromMe }, "whatsapp webhook: internal number, skipping");
    return;
  }

  let guestId: string;
  let enquiryId: string | undefined;
  const pushName = data.pushName?.trim() || null;

  if (fromMe) {
    // Sent from the linked phone's native WhatsApp app, not through the CRM.
    // Only sync it onto a conversation that already exists — never
    // auto-create a lead from an outbound-only contact, same reasoning as
    // isInternalPhone: an admin/rep texting someone from their own phone
    // shouldn't spawn a fake lead.
    const existing = await prisma.guest.findFirst({
      where: { phone, deletedAt: null },
      select: { id: true, enquiries: { orderBy: { lastActivityAt: "desc" }, take: 1, select: { id: true } } },
    });
    if (!existing) return;
    guestId = existing.id;
    enquiryId = existing.enquiries[0]?.id;
  } else {
    // A blocked guest's incoming message is dropped here, before anything
    // is stored — checked against phone directly rather than through
    // resolveGuestByPhone, since blocking only ever applies to a guest that
    // already exists (you can't block someone before they're a guest), and
    // this way a blocked guest never gets a Message/Activity row or a
    // needsAttention flip out of an inbound message we're supposed to ignore.
    // No deletedAt filter: a guest who was blocked and THEN soft-deleted must
    // stay blocked on the way back in. Scoping this to live guests would let
    // their next message through and — now that resolveGuestByPhone revives a
    // soft-deleted guest — quietly un-hide them too.
    const existingByPhone = await prisma.guest.findFirst({
      where: { phone },
      select: { id: true, isBlocked: true },
    });
    if (existingByPhone?.isBlocked) {
      logger.info({ instanceName, phone }, "whatsapp webhook: inbound from blocked guest, ignoring");
      return;
    }
    const resolved = await resolveGuestByPhone(phone, pushName);
    guestId = resolved.guestId;
    enquiryId = resolved.enquiryId;
  }

  // Text is the common case — cheap to resolve without a second API call.
  const textOnly = data.message?.conversation || data.message?.extendedTextMessage?.text || null;
  const media = textOnly ? null : detectInboundMedia(data.message ?? {});

  let attachmentDocumentId: string | null = null;
  let body: string;

  if (media) {
    try {
      // Use the ORIGINAL remoteJid (rawJid, possibly @lid) here, not the
      // @lid-resolved `jid` — Evolution/Baileys keys its message cache by
      // whatever remoteJid the event actually reported, so that's what a
      // media lookup for this specific message needs to match.
      const { base64 } = await getMediaBase64(instanceName, {
        id: messageId,
        remoteJid: rawJid ?? jid,
        fromMe,
      });
      const buffer = Buffer.from(base64, "base64");
      const storageKey = buildStorageKey({
        category: "operational",
        filename: media.fileName,
        guestId,
        enquiryId,
      });
      await putObjectBuffer(storageKey, buffer, media.mimetype);
      const doc = await prisma.document.create({
        data: {
          category: "operational",
          filename: media.fileName,
          mimeType: media.mimetype,
          storageKey,
          sizeBytes: buffer.byteLength,
          uploadedBy: "inbound-whatsapp",
          guestId,
          enquiryId,
        },
      });
      attachmentDocumentId = doc.id;
      body = describeInboundMedia(media);
    } catch (err) {
      logger.error({ err, instanceName, messageId }, "whatsapp media download failed");
      body = "[Media message — download failed]";
    }
  } else {
    // Reactions, locations, shared contacts, polls, button/list replies and
    // friends carry no downloadable media but are perfectly describable —
    // before this they all collapsed into "[Unsupported message type]".
    body = textOnly || describeNonMediaMessage(data.message ?? {}) || "[Unsupported message type]";
  }

  // A reply points at the message it quotes. Reuse `inReplyTo` (email uses it
  // for the RFC Message-ID) to hold the quoted message's WhatsApp id, so the
  // thread can show what was being replied to.
  const inReplyTo = quotedMessageId(data.message ?? {});

  await prisma.message.create({
    data: {
      guestId,
      enquiryId: enquiryId ?? null,
      mailboxId: instanceName,
      channel: "whatsapp",
      direction: fromMe ? "outbound" : "inbound",
      body,
      fromEmail: fromMe ? number.phoneNumber : phone,
      toEmail: fromMe ? phone : number.phoneNumber,
      externalId: messageId,
      inReplyTo,
      attachmentDocumentId,
      status: fromMe ? "sent" : "received",
    },
  });

  await prisma.activity.create({
    data: {
      guestId,
      enquiryId: enquiryId ?? null,
      actorSub: fromMe ? "whatsapp-mobile" : "inbound",
      actorRole: "system",
      actorName: fromMe ? "WhatsApp mobile app" : (pushName ?? phone),
      actionType: fromMe ? "message_sent" : "message_received",
      metadata: { channel: "whatsapp", instance: instanceName, numberLabel: number.label },
    },
  });

  // Outbound (whether sent via the CRM or, here, from the phone directly)
  // doesn't flip needsAttention — that's reserved for things waiting on a
  // reply. Matches how /api/messages/whatsapp's own CRM-sent path behaves.
  if (!fromMe && enquiryId) {
    await prisma.enquiry.update({
      where: { id: enquiryId },
      data: { needsAttention: true, lastActivityAt: new Date() },
    }).catch(() => null);
  }

  // Auto-reply only ever fires on a genuine inbound guest message — never on
  // fromMe (a rep's own phone) traffic. maybeSendAutoReply() never throws.
  if (!fromMe) {
    await maybeSendAutoReply({ number, guestId, enquiryId, phone, body });
  }

  logger.info({ instanceName, phone, fromMe }, fromMe ? "whatsapp mobile-app send synced" : "whatsapp inbound stored");
}

interface UpdateData {
  keyId?: string;
  messageId?: string;
  key?: { id?: string };
  status?: string | number;
  update?: { status?: string | number };
}

/**
 * A message we sent progressing sent -> delivered -> read, or failing after
 * the fact — for Baileys (QR-paired) numbers, which Evolution normalizes and
 * relays here correctly. Cloud API numbers' status events don't reach this
 * handler — Evolution's own re-normalization of those crashes internally
 * before it can relay them — see the whatsapp-cloud-relay route, which
 * parses Meta's webhook directly instead. Requires
 * WEBHOOK_EVENTS_MESSAGES_UPDATE enabled in docker-compose.yml.
 */
async function handleMessagesUpdate(data: UpdateData) {
  // Logged unconditionally while this is new/unverified against live
  // traffic — the exact field names Evolution sends aren't fully documented
  // upstream (see docs/17), so this is the fastest way to confirm or correct
  // the shape assumed below. Fine to drop to debug once confirmed stable.
  logger.info({ data }, "whatsapp webhook: messages.update received");

  const messageId = data.keyId ?? data.key?.id ?? data.messageId;
  const rawStatus = data.status ?? data.update?.status;
  if (!messageId) return;

  await applyWhatsAppStatusUpdate(messageId, rawStatus);
}

async function handleConnectionUpdate(instanceName: string, data: { state?: string }) {
  const number = await prisma.whatsAppNumber.findUnique({ where: { instanceName } });
  if (!number) return;
  const status = data.state === "open" ? "connected" : data.state === "close" ? "disconnected" : number.status;

  // Backfill the paired account's own number the moment we see it come
  // online. Without this, isInternalPhone() has nothing to match against —
  // it only ever got set opportunistically while an admin had the QR/connect
  // page open during pairing — so the instance's own traffic (and any
  // personal chats on that same phone) never got recognized as internal.
  let phoneNumber = number.phoneNumber;
  if (status === "connected" && !phoneNumber) {
    const conn = await getConnectionState(instanceName).catch(() => null);
    phoneNumber = conn?.phoneNumber ?? null;
  }

  if (status !== number.status || phoneNumber !== number.phoneNumber) {
    await prisma.whatsAppNumber.update({
      where: { id: number.id },
      data: { status, ...(phoneNumber !== number.phoneNumber ? { phoneNumber } : {}) },
    });
  }
}

export async function POST(req: NextRequest) {
  if (!secretOk(req)) {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "Invalid secret" } }, { status: 403 });
  }

  let payload: { event?: string; instance?: string; data?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: { code: "BAD_REQUEST", message: "Invalid JSON" } }, { status: 400 });
  }

  const { event, instance } = payload;
  try {
    if (event === "messages.upsert" && instance) {
      await handleMessagesUpsert(instance, (payload.data ?? {}) as UpsertData);
    } else if (event === "messages.update" && instance) {
      // Seen batched as an array in some Evolution versions, a single object
      // in others — normalize to an array so both work.
      const updates = Array.isArray(payload.data) ? payload.data : [payload.data ?? {}];
      for (const update of updates) {
        await handleMessagesUpdate(update as UpdateData);
      }
    } else if (event === "connection.update" && instance) {
      await handleConnectionUpdate(instance, (payload.data ?? {}) as { state?: string });
    }
  } catch (err) {
    // Evolution retries on non-2xx — log and still 200 so a transient bug in
    // our handling doesn't cause it to hammer the endpoint.
    logger.error({ err, event, instance }, "whatsapp webhook processing failed");
  }

  return NextResponse.json({ ok: true });
}
