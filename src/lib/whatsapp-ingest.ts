/**
 * Storing one inbound (or phone-side outbound) WhatsApp message — the part
 * that is identical no matter which channel delivered it.
 *
 * Two webhooks feed this: /api/webhooks/whatsapp (Evolution API, for the
 * QR-paired Baileys numbers) and /api/webhooks/whatsapp-cloud (Meta itself,
 * for Cloud API numbers). Their payloads have nothing in common — Baileys'
 * `messages.upsert` shape vs Meta's `entry[].changes[].value.messages[]` —
 * so each route normalizes its own into NormalizedWhatsAppMessage and hands
 * it here. Everything downstream of that (dedup, internal-number and blocked
 * filtering, lead resolution, media persistence, activity, needs-attention,
 * reply tags, auto tags, auto-reply) is one implementation, so the two
 * channels can't drift in how a conversation behaves.
 *
 * Before this, the Cloud API path reached the Evolution handler by being
 * relayed THROUGH Evolution, which is what kept a proxy in front of Meta for
 * no gain — and dropped every Cloud API delivery status on the way.
 */
import type { WhatsAppNumber } from "@prisma/client";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { buildStorageKey, putObjectBuffer } from "./storage";
import { resolveGuestByPhone, isInternalPhone } from "./whatsapp";
import { maybeSendAutoReply } from "./whatsapp-autoreply";
import { applyReplyTag } from "./reply-tag";
import { applyAutoTags } from "./auto-tag";
import { applyScheduledTags } from "./scheduled-tag";
import { tagWhatsAppNumberUsed } from "./whatsapp-number-tag";
import { isVoiceNoteMime } from "./voice-note";
import { queueVoiceNoteTranscription } from "./ai/voice-note-transcribe";

export interface InboundMediaPayload {
  mimeType: string;
  fileName: string;
  /** Fetches the bytes. Deferred so nothing is downloaded for a message that
   *  turns out to be a duplicate, internal, or from a blocked guest. */
  download: () => Promise<{ buffer: Buffer; mimeType?: string }>;
}

export interface NormalizedWhatsAppMessage {
  /** WhatsApp's own message id — the dedup key, and what a delivery status
   *  later refers to. */
  externalId: string;
  /** The other party's number, E.164. */
  phone: string;
  /** True when this is the linked phone/business number sending, not the guest. */
  fromMe: boolean;
  pushName: string | null;
  /** WhatsApp's send time; the row falls back to now() without it. */
  sentAt?: Date;
  /** WhatsApp id of the message being replied to, or null. */
  inReplyTo: string | null;
  /** Already-rendered body: the text, the media caption, or a label. */
  body: string;
  media: InboundMediaPayload | null;
}

export async function ingestWhatsAppMessage(
  number: WhatsAppNumber,
  msg: NormalizedWhatsAppMessage,
): Promise<void> {
  const instanceName = number.instanceName;
  const { externalId, phone, fromMe, pushName } = msg;

  const dup = await prisma.message.findFirst({ where: { channel: "whatsapp", externalId } });
  if (dup) return; // webhook retry, or the echo of a message we already stored via our own send API

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
  let isNewGuest = false;

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
    const resolved = await resolveGuestByPhone(phone, pushName, number.phoneNumber);
    guestId = resolved.guestId;
    enquiryId = resolved.enquiryId;
    isNewGuest = resolved.created ?? false;
  }

  let attachmentDocumentId: string | null = null;
  let voiceNote = false;
  let body = msg.body;

  if (msg.media) {
    try {
      const { buffer, mimeType } = await msg.media.download();
      const storageKey = buildStorageKey({
        category: "operational",
        filename: msg.media.fileName,
        guestId,
        enquiryId,
      });
      const resolvedMime = mimeType || msg.media.mimeType;
      await putObjectBuffer(storageKey, buffer, resolvedMime);
      const doc = await prisma.document.create({
        data: {
          category: "operational",
          filename: msg.media.fileName,
          mimeType: resolvedMime,
          storageKey,
          sizeBytes: buffer.byteLength,
          uploadedBy: "inbound-whatsapp",
          guestId,
          enquiryId,
        },
      });
      attachmentDocumentId = doc.id;
      voiceNote = isVoiceNoteMime(resolvedMime);
    } catch (err) {
      logger.error({ err, instanceName, messageId: externalId }, "whatsapp media download failed");
      body = "[Media message — download failed]";
    }
  }

  const message = await prisma.message.create({
    data: {
      guestId,
      enquiryId: enquiryId ?? null,
      mailboxId: instanceName,
      channel: "whatsapp",
      direction: fromMe ? "outbound" : "inbound",
      body,
      fromEmail: fromMe ? number.phoneNumber : phone,
      toEmail: fromMe ? phone : number.phoneNumber,
      externalId,
      inReplyTo: msg.inReplyTo,
      attachmentDocumentId,
      status: fromMe ? "sent" : "received",
      // WhatsApp's send time when it gave us one; otherwise the default now().
      ...(msg.sentAt ? { createdAt: msg.sentAt } : {}),
    },
  });

  // Which of our lines this conversation is on. Inbound counts as much as
  // outbound — the guest wrote to this number, which is exactly what opens
  // Meta's 24-hour window on it.
  await tagWhatsAppNumberUsed(guestId, number.phoneNumber);

  await prisma.activity.create({
    data: {
      guestId,
      enquiryId: enquiryId ?? null,
      actorSub: fromMe ? "whatsapp-mobile" : "inbound",
      actorRole: "system",
      actorName: fromMe ? "WhatsApp mobile app" : (pushName ?? phone),
      actionType: fromMe ? "message_sent" : "message_received",
      metadata: {
        channel: "whatsapp",
        instance: instanceName,
        numberLabel: number.label,
        // Our number, recorded outright — see lib/whatsapp-lines.ts.
        line: number.phoneNumber,
        // Lets the log show this as a voice note and pick up its transcript
        // once the background pass has one — see lib/voice-note.ts.
        ...(voiceNote ? { voiceNote: true, messageId: message.id } : {}),
      },
    },
  });

  // Decoded in the background: the webhook has to answer Evolution/Meta
  // immediately, and a decode takes seconds.
  if (voiceNote) queueVoiceNoteTranscription(message.id);

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
    // A guest answering a tagged broadcast earns that tag on their lead.
    // Only inbound counts — a rep replying from their own phone isn't the
    // guest responding. Never throws.
    await applyReplyTag({ guestId, enquiryId, channel: "whatsapp", inReplyTo: msg.inReplyTo });
    // Tag the lead from what they actually said ("price", "single
    // occupancy", …). Independent of the reply rules and of reply-tagging:
    // all three can fire on one message. Never throws.
    await applyAutoTags({ numberId: number.id, guestId, enquiryId, body });
    // And tag by WHEN they wrote: a campaign window on this number tags
    // everyone who answers it, whatever they say. Never throws.
    await applyScheduledTags({ numberId: number.id, guestId, enquiryId });
    await maybeSendAutoReply({ number, guestId, enquiryId, phone, body, isNewGuest });
  }

  logger.info({ instanceName, phone, fromMe }, fromMe ? "whatsapp mobile-app send synced" : "whatsapp inbound stored");
}
