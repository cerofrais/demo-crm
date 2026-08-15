import type { WhatsAppNumber } from "@prisma/client";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { createEnquiry } from "./enquiry-service";
import { reviveEnquiryIfDeleted } from "./enquiries";
import { reviveGuestIfDeleted } from "./guest-revive";
import { sendText, sendMedia, sendAudio, type WhatsAppMediaType } from "./whatsapp-admin";

/** WhatsApp JID ("919876543210@s.whatsapp.net") -> our E.164 phone format. */
export function fromWhatsAppJid(jid: string): string {
  const digits = jid.split("@")[0].replace(/\D/g, "");
  return `+${digits}`;
}

/** Our E.164 phone -> the bare-digits format Evolution/WhatsApp expects. */
export function toWhatsAppNumber(e164: string): string {
  return e164.replace(/^\+/, "");
}

export async function sendWhatsAppMessage(
  number: WhatsAppNumber,
  to: string,
  text: string,
): Promise<{ externalId: string | null }> {
  return sendText(number.instanceName, to, text);
}

/** Sends an already-uploaded document as a WhatsApp attachment, routing to
 * the native voice-note endpoint for audio and the generic media endpoint
 * for everything else. */
export async function sendWhatsAppMedia(
  number: WhatsAppNumber,
  to: string,
  opts: { mimeType: string; fileName: string; base64: string; caption?: string },
): Promise<{ externalId: string | null }> {
  if (opts.mimeType.startsWith("audio/")) {
    return sendAudio(number.instanceName, to, opts.base64);
  }
  const mediatype: WhatsAppMediaType = opts.mimeType.startsWith("image/")
    ? "image"
    : opts.mimeType.startsWith("video/")
      ? "video"
      : "document";
  return sendMedia(number.instanceName, to, {
    mediatype,
    mimetype: opts.mimeType,
    media: opts.base64,
    fileName: opts.fileName,
    caption: opts.caption,
  });
}

// ---------------------------------------------------------------------------
// Inbound media detection (webhook payloads)
// ---------------------------------------------------------------------------

export interface InboundMediaInfo {
  kind: "image" | "video" | "audio" | "document" | "sticker";
  mimetype: string;
  caption: string | null;
  fileName: string;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "application/pdf": "pdf",
};

function extFor(mimetype: string): string {
  return EXT_BY_MIME[mimetype] ?? mimetype.split("/")[1]?.split(";")[0] ?? "bin";
}

/** A quoted-reply pointer. Evolution normalises a reply to `{contextInfo:
 * {stanzaId}}` alongside the reply's own content, where stanzaId is the
 * WhatsApp id of the message being replied to. Baileys also nests the same
 * contextInfo inside the typed message (extendedTextMessage, imageMessage…),
 * so both shapes are read. */
interface WaContextInfo {
  stanzaId?: string;
  quotedMessage?: WaMessageContent;
}

export interface WaMessageContent {
  conversation?: string;
  contextInfo?: WaContextInfo;
  extendedTextMessage?: { text?: string; contextInfo?: WaContextInfo };
  imageMessage?: { caption?: string; mimetype?: string; contextInfo?: WaContextInfo };
  videoMessage?: { caption?: string; mimetype?: string; contextInfo?: WaContextInfo };
  audioMessage?: { mimetype?: string; contextInfo?: WaContextInfo };
  documentMessage?: { caption?: string; mimetype?: string; fileName?: string; contextInfo?: WaContextInfo };
  documentWithCaptionMessage?: { message?: { documentMessage?: { caption?: string; mimetype?: string; fileName?: string } } };
  stickerMessage?: { mimetype?: string; contextInfo?: WaContextInfo };
  // Types below carry no downloadable media; they're rendered as a text label
  // by describeNonMediaMessage() rather than becoming a Document.
  reactionMessage?: { text?: string; key?: { id?: string } };
  locationMessage?: { degreesLatitude?: number; degreesLongitude?: number; name?: string; address?: string };
  liveLocationMessage?: { degreesLatitude?: number; degreesLongitude?: number };
  contactMessage?: { displayName?: string };
  contactsArrayMessage?: { displayName?: string; contacts?: unknown[] };
  albumMessage?: { expectedImageCount?: number; expectedVideoCount?: number };
  pollCreationMessage?: { name?: string };
  pollCreationMessageV3?: { name?: string };
  eventMessage?: { name?: string };
  orderMessage?: { itemCount?: number };
  listMessage?: { title?: string };
  templateMessage?: unknown;
  interactiveMessage?: unknown;
  buttonsMessage?: unknown;
  listResponseMessage?: { title?: string };
  buttonsResponseMessage?: { selectedDisplayText?: string };
  templateButtonReplyMessage?: { selectedDisplayText?: string };
  secretEncryptedMessage?: unknown;
}

/**
 * The WhatsApp id of the message this one replies to, or null when it isn't a
 * reply. Checked at the top level (Evolution's normalised shape) and inside
 * each typed message (Baileys' native shape) — a reply can carry media, so
 * this is deliberately independent of detectInboundMedia().
 */
export function quotedMessageId(message: WaMessageContent): string | null {
  const candidates = [
    message.contextInfo,
    message.extendedTextMessage?.contextInfo,
    message.imageMessage?.contextInfo,
    message.videoMessage?.contextInfo,
    message.audioMessage?.contextInfo,
    message.documentMessage?.contextInfo,
    message.stickerMessage?.contextInfo,
  ];
  for (const ctx of candidates) {
    const id = ctx?.stanzaId?.trim();
    if (id) return id;
  }
  return null;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Human-readable label for a message that carries no downloadable media and
 * isn't plain text — reactions, locations, shared contacts, polls, order and
 * button/list replies. Without this every one of them was stored as the
 * useless "[Unsupported message type]"; 130 rows on this deployment, the
 * largest groups being reactions, albums and locations.
 *
 * Returns null for anything genuinely unrecognised, so the caller keeps its
 * existing fallback rather than inventing a label.
 */
export function describeNonMediaMessage(message: WaMessageContent): string | null {
  if (message.reactionMessage) {
    const emoji = message.reactionMessage.text?.trim();
    // An empty reaction body is WhatsApp's "reaction removed" signal.
    return emoji ? `Reacted ${emoji}` : "Removed a reaction";
  }
  const loc = message.locationMessage ?? message.liveLocationMessage;
  if (loc) {
    const named = message.locationMessage?.name ?? message.locationMessage?.address;
    const coords =
      loc.degreesLatitude != null && loc.degreesLongitude != null
        ? `${loc.degreesLatitude.toFixed(5)}, ${loc.degreesLongitude.toFixed(5)}`
        : null;
    const live = message.liveLocationMessage ? "Live location" : "Location";
    return `📍 ${live}${named ? `: ${named}` : ""}${coords ? ` (${coords})` : ""}`;
  }
  if (message.contactMessage || message.contactsArrayMessage) {
    const name = message.contactMessage?.displayName ?? message.contactsArrayMessage?.displayName;
    const count = message.contactsArrayMessage?.contacts?.length;
    if (count && count > 1) return `👤 Shared ${plural(count, "contact")}`;
    return `👤 Shared contact${name ? `: ${name}` : ""}`;
  }
  if (message.albumMessage) {
    const images = message.albumMessage.expectedImageCount ?? 0;
    const videos = message.albumMessage.expectedVideoCount ?? 0;
    const total = images + videos;
    // The album header arrives first; the individual items follow as their own
    // messages and are stored separately, so this is a marker, not a loss.
    return total ? `🖼️ Album (${plural(total, "item")})` : "🖼️ Album";
  }
  const poll = message.pollCreationMessage ?? message.pollCreationMessageV3;
  if (poll) return `📊 Poll${poll.name ? `: ${poll.name}` : ""}`;
  if (message.eventMessage) {
    return `📅 Event${message.eventMessage.name ? `: ${message.eventMessage.name}` : ""}`;
  }
  if (message.orderMessage) {
    const n = message.orderMessage.itemCount;
    return `🛒 Order${n ? ` (${plural(n, "item")})` : ""}`;
  }
  const buttonReply =
    message.buttonsResponseMessage?.selectedDisplayText ??
    message.templateButtonReplyMessage?.selectedDisplayText ??
    message.listResponseMessage?.title;
  if (buttonReply) return buttonReply;
  if (message.listMessage?.title) return `📋 ${message.listMessage.title}`;
  if (message.templateMessage || message.interactiveMessage || message.buttonsMessage) {
    return "[Interactive message]";
  }
  // WhatsApp couldn't decrypt this for us; nothing is recoverable.
  if (message.secretEncryptedMessage) return "[Encrypted message — not readable]";
  return null;
}

/** Detects a media type from a messages.upsert `data.message` object, or
 * null for a plain-text message. Filenames are generated when WhatsApp
 * doesn't supply one (only documentMessage reliably does). */
export function detectInboundMedia(message: WaMessageContent): InboundMediaInfo | null {
  const doc = message.documentMessage ?? message.documentWithCaptionMessage?.message?.documentMessage;
  if (doc) {
    const mimetype = doc.mimetype ?? "application/octet-stream";
    return {
      kind: "document",
      mimetype,
      caption: doc.caption?.trim() || null,
      fileName: doc.fileName || `document-${Date.now()}.${extFor(mimetype)}`,
    };
  }
  if (message.imageMessage) {
    const mimetype = message.imageMessage.mimetype ?? "image/jpeg";
    return {
      kind: "image",
      mimetype,
      caption: message.imageMessage.caption?.trim() || null,
      fileName: `photo-${Date.now()}.${extFor(mimetype)}`,
    };
  }
  if (message.videoMessage) {
    const mimetype = message.videoMessage.mimetype ?? "video/mp4";
    return {
      kind: "video",
      mimetype,
      caption: message.videoMessage.caption?.trim() || null,
      fileName: `video-${Date.now()}.${extFor(mimetype)}`,
    };
  }
  if (message.audioMessage) {
    const mimetype = message.audioMessage.mimetype ?? "audio/ogg";
    return { kind: "audio", mimetype, caption: null, fileName: `voice-note-${Date.now()}.${extFor(mimetype)}` };
  }
  if (message.stickerMessage) {
    const mimetype = message.stickerMessage.mimetype ?? "image/webp";
    return { kind: "sticker", mimetype, caption: null, fileName: `sticker-${Date.now()}.${extFor(mimetype)}` };
  }
  return null;
}

const MEDIA_LABEL: Record<InboundMediaInfo["kind"], string> = {
  image: "📷 Photo",
  video: "🎥 Video",
  audio: "🎤 Voice message",
  document: "📄 Document",
  sticker: "Sticker",
};

/** Message.body text for a media message — the caption if present, else a type label. */
export function describeInboundMedia(info: InboundMediaInfo): string {
  return info.caption || MEDIA_LABEL[info.kind];
}

/**
 * True if `phone` belongs to the CRM itself — a staff member's own
 * click-to-call number, or one of our own connected WhatsApp business
 * numbers — never a real guest. A staff member's personal WhatsApp is
 * commonly paired as a business number for testing; once linked, Evolution
 * mirrors *all* traffic on that phone (including chats with people who have
 * nothing to do with the CRM), so this must be checked before ever
 * auto-creating a lead from an inbound sender.
 */
export async function isInternalPhone(phone: string): Promise<boolean> {
  const [staff, number] = await Promise.all([
    prisma.staffProfile.findFirst({ where: { phone }, select: { keycloakId: true } }),
    prisma.whatsAppNumber.findFirst({ where: { phoneNumber: phone }, select: { id: true } }),
  ]);
  return Boolean(staff || number);
}

/**
 * If the logged-in staff member's own phone (StaffProfile.phone) is also a
 * connected WhatsAppNumber — their personal WhatsApp paired as a business
 * number — return that number's id so send-from pickers can default to it.
 * Otherwise a rep would see some other line preselected and could send a
 * reply from a number that isn't theirs without noticing.
 */
export async function resolveMyWhatsAppNumberId(sub: string): Promise<string | null> {
  const staff = await prisma.staffProfile.findUnique({ where: { keycloakId: sub }, select: { phone: true } });
  if (!staff?.phone) return null;
  const number = await prisma.whatsAppNumber.findFirst({
    // shared: false means an admin has deliberately taken this number out of
    // the staff-facing pool (scaling down how many numbers are offered) —
    // it shouldn't get auto-selected just because it happens to match.
    where: { phoneNumber: staff.phone, status: "connected", shared: true },
    select: { id: true },
  });
  return number?.id ?? null;
}

/**
 * Resolve (or auto-create) the guest + enquiry an inbound WhatsApp message
 * belongs to, by phone number. Mirrors resolveGuestId() in inbound-mail.ts
 * for email, but simpler — no thread-header matching needed, a phone number
 * is already a direct, reliable match against Guest.phone.
 */
export async function resolveGuestByPhone(
  phone: string,
  pushName: string | null,
): Promise<{ guestId: string; enquiryId?: string }> {
  // Includes soft-deleted GUESTS as well as soft-deleted enquiries — a
  // re-engaging guest revives their hidden record and ticket instead of
  // getting a silent duplicate opened underneath them (or, for the guest,
  // a P2002 on the still-unique phone number). Blocked guests never reach
  // here: the webhook drops them before this call.
  const guest = await prisma.guest.findFirst({
    where: { phone },
    select: {
      id: true,
      deletedAt: true,
      enquiries: {
        orderBy: { lastActivityAt: "desc" },
        take: 1,
        select: { id: true, deletedAt: true },
      },
    },
  });
  if (guest?.deletedAt) {
    await reviveGuestIfDeleted(guest.id, "inbound WhatsApp message");
  }
  if (guest?.enquiries[0]) {
    const enquiry = guest.enquiries[0];
    if (enquiry.deletedAt) await reviveEnquiryIfDeleted(enquiry.id);
    return { guestId: guest.id, enquiryId: enquiry.id };
  }

  // A brand-new sender — nothing to attach to, so open a fresh enquiry.
  // createEnquiry() does its own returning-guest lookup by phone, so an
  // existing guest record (with zero enquiries at all) is reused rather
  // than duplicated.
  try {
    const result = await createEnquiry({
      fullName: pushName?.trim() || phone,
      phone,
      source: "whatsapp",
      note: "Inbound WhatsApp message",
    });
    return { guestId: result.enquiry.guest.id, enquiryId: result.enquiry.id };
  } catch (err) {
    logger.error({ err, phone }, "whatsapp auto-enquiry failed; falling back to guest-only capture");
    // This upsert matches on phone alone, so it can land on a soft-deleted
    // guest — which would file the message against a record nobody can see.
    // Revive here too: whatever made createEnquiry fail, the message itself
    // is real inbound contact.
    const fallback = await prisma.guest.upsert({
      where: { phone },
      update: {},
      create: { fullName: pushName?.trim() || phone, phone },
      select: { id: true },
    });
    await reviveGuestIfDeleted(fallback.id, "inbound WhatsApp message (enquiry creation failed)");
    return { guestId: fallback.id };
  }
}

// ---------------------------------------------------------------------------
// Delivery-status updates (sent -> delivered -> read, or failed)
// ---------------------------------------------------------------------------

// Baileys' own status enum, which Evolution passes through largely as-is for
// QR-paired numbers — seen as either the string name or the raw number
// depending on version/path. Meta's native Cloud API webhook uses plain
// lowercase words ("sent"/"delivered"/"read"/"failed") for the same states,
// which also normalize correctly here since everything is upper-cased first.
// PENDING/SERVER_ACK (message queued/reached WhatsApp's server, not yet the
// recipient's device) aren't worth recording — indistinguishable from our own
// "sent" default. PLAYED (voice note listened to) counts as read.
export function normalizeDeliveryStatus(raw: unknown): "delivered" | "read" | "failed" | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toUpperCase();
  if (s === "READ" || s === "PLAYED" || s === "4" || s === "5") return "read";
  if (s === "DELIVERY_ACK" || s === "DELIVERED" || s === "3") return "delivered";
  if (s === "ERROR" || s === "FAILED" || s === "0") return "failed";
  return null;
}

const STATUS_RANK: Record<string, number> = { sent: 0, delivered: 1, read: 2 };

/**
 * A message we sent progressing sent -> delivered -> read, or failing after
 * the fact (WhatsApp accepted the send, then delivery itself failed) —
 * matched by externalId, the id we stored at send time (the Evolution
 * message key for a Baileys number, or the Meta wamid for a Cloud API one —
 * see /api/messages/whatsapp and broadcast.ts). Only ever moves status
 * forward (or to "failed", which always wins) — an out-of-order retry can't
 * downgrade an already-read message back to "delivered".
 *
 * Shared by two callers: the Evolution-normalized `messages.update` handler
 * below (Baileys numbers — Evolution relays these fine) and the Cloud API
 * relay route (which parses Meta's own webhook payload directly, since
 * Evolution's own re-normalization of Cloud API status events crashes
 * internally and never reaches us — see that route's comment).
 */
export async function applyWhatsAppStatusUpdate(
  externalId: string,
  rawStatus: unknown,
  errorDetail?: string | null,
): Promise<void> {
  const next = normalizeDeliveryStatus(rawStatus);
  if (!next) return; // PENDING/SERVER_ACK/unrecognized — nothing worth recording

  const message = await prisma.message.findFirst({
    where: { channel: "whatsapp", externalId },
  });
  if (!message) return; // not one of ours, or a status update that raced ahead of the send-time write

  if (next !== "failed" && (STATUS_RANK[next] ?? 0) <= (STATUS_RANK[message.status] ?? 0)) return;

  await prisma.message.update({
    where: { id: message.id },
    data: next === "failed"
      ? { status: "failed", errorDetail: errorDetail ?? message.errorDetail ?? "Delivery failed after being sent" }
      : { status: next },
  });
  logger.info({ externalId, status: next }, "whatsapp: message delivery status updated");
}
