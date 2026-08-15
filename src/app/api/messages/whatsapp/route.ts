import { NextRequest } from "next/server";
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { sendWhatsAppMessageSchema } from "@/lib/validation";
import { sendWhatsAppMessage, sendWhatsAppMedia } from "@/lib/whatsapp";
import { getObjectBuffer } from "@/lib/storage";
import { findAttachableDocument } from "@/lib/attachment-access";
import { toMessageDTO } from "@/lib/messages";
import { touchLead } from "@/lib/enquiries";
import { logger } from "@/lib/logger";

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
            to: guest.phone,
          },
        },
      });
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
