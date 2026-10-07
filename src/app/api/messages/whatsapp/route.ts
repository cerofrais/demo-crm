import { NextRequest } from "next/server";
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { canUseWhatsAppIntegration } from "@/lib/rbac";
import { sendWhatsAppMessageSchema } from "@/lib/validation";
import { sendWhatsAppMessage, sendWhatsAppMedia } from "@/lib/whatsapp";
import { tagWhatsAppNumberUsed } from "@/lib/whatsapp-number-tag";
import { getObjectBuffer } from "@/lib/storage";
import { findAttachableDocument } from "@/lib/attachment-access";
import { toMessageDTO } from "@/lib/messages";
import { isVoiceNoteMime } from "@/lib/voice-note";
import { queueVoiceNoteTranscription } from "@/lib/ai/voice-note-transcribe";
import { touchLead } from "@/lib/enquiries";
import { logger } from "@/lib/logger";
import { allowedWhatsAppNumbersFor, isNumberAllowed } from "@/lib/whatsapp-number-access";
import { sendTemplateToGuest } from "@/lib/whatsapp-template-send";
import type { AuthContext } from "@/lib/api";
import type { WhatsAppNumber } from "@prisma/client";

export const dynamic = "force-dynamic";

/**
 * POST /api/messages/whatsapp — send a WhatsApp message (text and/or an
 * attachment) to a guest from the chosen connected number, persist it to the
 * guest-level thread, and log it. Mirrors POST /api/messages/email.
 */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requirePermission("messaging.send");
    const input = sendWhatsAppMessageSchema.parse(await req.json());

    const guest = await prisma.guest.findFirst({
      where: { id: input.guestId, deletedAt: null },
      select: { id: true, phone: true },
    });
    if (!guest) throw new ApiError("NOT_FOUND", "Guest not found", 404);
    if (!guest.phone) throw new ApiError("NO_PHONE", "This guest has no phone number.", 400);

    const number = await prisma.whatsAppNumber.findUnique({ where: { id: input.numberId } });
    if (!number) throw new ApiError("NOT_FOUND", "WhatsApp number not found", 404);
    if (number.status !== "connected") {
      throw new ApiError("NOT_CONNECTED", "This WhatsApp number isn't connected.", 400);
    }
    // Enforced here too, not just hidden from the picker: the number id comes
    // from the client, so a stale page or a direct call must still be refused.
    if (!canUseWhatsAppIntegration(ctx.roles, number.integration)) {
      throw new ApiError(
        "FORBIDDEN",
        "Only Admin, Manager and Doctor can send from the official WhatsApp number.",
        403,
      );
    }
    // An admin can pin a person to specific lines on the Users page. Checked
    // here, not just filtered out of the picker, for the same reason as the
    // check above: the number id comes from the client.
    if (!isNumberAllowed(await allowedWhatsAppNumbersFor(ctx.sub), number.phoneNumber)) {
      throw new ApiError(
        "FORBIDDEN",
        "You aren't assigned to send from this WhatsApp number. An admin can change that on the Users page.",
        403,
      );
    }

    // The attachment is a Document already created by the upload-url/confirm
    // flow (so it's already visible in the guest/enquiry's Documents tab), or
    // a shared Resources-library file picked in the composer.
    let attachment: { mimeType: string; fileName: string; base64: string } | null = null;
    if (input.attachmentDocumentId) {
      // This guest's own documents, or a shared Resources-library file — see
      // findAttachableDocument. Never another guest's.
      const doc = await findAttachableDocument(input.attachmentDocumentId, guest.id, ctx.roles);
      if (!doc) throw new ApiError("NOT_FOUND", "Attachment not found", 404);
      const buffer = await getObjectBuffer(doc.storageKey);
      attachment = { mimeType: doc.mimeType, fileName: doc.filename, base64: buffer.toString("base64") };
    }

    // A template send is its own path: Meta builds the message from its own
    // approved copy, so there is no body to send and none to trust from the
    // page — see lib/whatsapp-template-send.ts.
    if (input.template) {
      if (attachment) {
        throw new ApiError("BAD_REQUEST", "A template is sent on its own, without an attachment.", 400);
      }
      // The header image goes through the same ownership check as any other
      // attachment: this guest's own documents or the shared library, never
      // another guest's file.
      let headerDoc: { storageKey: string; mimeType: string; filename: string; id: string } | undefined;
      if (input.template.headerDocumentId) {
        const doc = await findAttachableDocument(input.template.headerDocumentId, guest.id, ctx.roles);
        if (!doc) throw new ApiError("NOT_FOUND", "Header image not found", 404);
        if (!doc.mimeType.startsWith("image/")) {
          throw new ApiError("BAD_REQUEST", "The header has to be an image.", 400);
        }
        headerDoc = { storageKey: doc.storageKey, mimeType: doc.mimeType, filename: doc.filename, id: doc.id };
      }
      return sendTemplate(input, number, guest, ctx, headerDoc);
    }

    const body = input.body?.trim() ?? "";
    const base = {
      guestId: guest.id,
      enquiryId: input.enquiryId ?? null,
      mailboxId: number.instanceName,
      channel: "whatsapp" as const,
      direction: "outbound" as const,
      body,
      fromEmail: number.phoneNumber,
      toEmail: guest.phone,
      attachmentDocumentId: input.attachmentDocumentId ?? null,
    };

    try {
      const res = attachment
        ? await sendWhatsAppMedia(number, guest.phone, { ...attachment, caption: body || undefined })
        : await sendWhatsAppMessage(number, guest.phone, body);
      const msg = await prisma.message.create({
        data: { ...base, externalId: res.externalId, status: "sent" },
        include: { attachmentDocument: true },
      });
      await tagWhatsAppNumberUsed(guest.id, number.phoneNumber);
      // A recorded voice note is marked on the activity itself, so the log can
      // show it as one (and hang its transcript off it) without re-reading the
      // attachment for every row.
      const voiceNote = isVoiceNoteMime(attachment?.mimeType);
      await prisma.activity.create({
        data: {
          guestId: guest.id,
          enquiryId: input.enquiryId ?? null,
          actorSub: ctx.sub,
          actorRole: ctx.roles[0] ?? "STAFF",
          actorName: ctx.name,
          actionType: "message_sent",
          metadata: {
            channel: "whatsapp",
            instance: number.instanceName,
            numberLabel: number.label,
            // The number itself — the instance changes on every re-pair and
            // the label is free text; see lib/whatsapp-lines.ts.
            line: number.phoneNumber,
            to: guest.phone,
            ...(voiceNote ? { voiceNote: true, messageId: msg.id } : {}),
          },
        },
      });
      // Transcribed in the background — the reply must not wait on ASR.
      if (voiceNote) queueVoiceNoteTranscription(msg.id);
      // Sending is activity on the lead — float it to the top of its column.
      await touchLead(input.enquiryId);
      return ok(toMessageDTO(msg, number.label), undefined, 201);
    } catch (err) {
      logger.error({ err, guestId: guest.id, numberId: number.id }, "whatsapp send failed");
      const msg = await prisma.message.create({
        data: {
          ...base,
          status: "failed",
          errorDetail: err instanceof Error ? err.message : "send failed",
        },
        include: { attachmentDocument: true },
      });
      return ok(toMessageDTO(msg, number.label));
    }
  });
}

/**
 * Send one approved Meta template to this guest and record it.
 *
 * Stored with the filled-in text as its body so the thread reads as the guest
 * read it, and marked in the activity metadata as a template send — "sent a
 * message" and "re-opened the window with an approved template" are different
 * acts, and only one of them is possible after 24 hours of silence.
 */
async function sendTemplate(
  input: { guestId: string; enquiryId?: string; template?: { name: string; language: string; params: string[] } },
  number: WhatsAppNumber,
  guest: { id: string; phone: string | null },
  ctx: AuthContext,
  headerDoc?: { storageKey: string; mimeType: string; filename: string; id: string },
) {
  const base = {
    guestId: guest.id,
    enquiryId: input.enquiryId ?? null,
    mailboxId: number.instanceName,
    channel: "whatsapp" as const,
    direction: "outbound" as const,
    fromEmail: number.phoneNumber,
    toEmail: guest.phone,
    // Kept on the message so the thread shows the picture the guest got,
    // not just the words under it.
    attachmentDocumentId: headerDoc?.id ?? null,
  };

  try {
    const sent = await sendTemplateToGuest(number, guest.phone!, {
      ...input.template!,
      headerImage: headerDoc
        ? { storageKey: headerDoc.storageKey, mimeType: headerDoc.mimeType, filename: headerDoc.filename }
        : undefined,
    });
    const msg = await prisma.message.create({
      data: {
        ...base,
        body: sent.body,
        metaTemplateName: input.template!.name,
        externalId: sent.externalId,
        status: "sent",
      },
      include: { attachmentDocument: true },
    });
    await tagWhatsAppNumberUsed(guest.id, number.phoneNumber);
    await prisma.activity.create({
      data: {
        guestId: guest.id,
        enquiryId: input.enquiryId ?? null,
        actorSub: ctx.sub,
        actorRole: ctx.roles[0] ?? "STAFF",
        actorName: ctx.name,
        actionType: "message_sent",
        metadata: {
          channel: "whatsapp",
          instance: number.instanceName,
          numberLabel: number.label,
          line: number.phoneNumber,
          to: guest.phone,
          messageId: msg.id,
          template: input.template!.name,
          viaMarketingApi: sent.viaMarketingApi,
        },
      },
    });
    await touchLead(input.enquiryId);
    return ok(toMessageDTO(msg, number.label), undefined, 201);
  } catch (err) {
    // A refusal we raised ourselves (not approved, missing placeholder) is
    // the rep's to fix, so it comes back as an error rather than as a failed
    // message in the thread.
    if (err instanceof ApiError) throw err;
    logger.error({ err, guestId: guest.id, template: input.template?.name }, "whatsapp template send failed");
    const msg = await prisma.message.create({
      data: {
        ...base,
        body: `(template: ${input.template!.name})`,
        metaTemplateName: input.template!.name,
        status: "failed",
        errorDetail: err instanceof Error ? err.message : "template send failed",
      },
      include: { attachmentDocument: true },
    });
    return ok(toMessageDTO(msg, number.label));
  }
}
