import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { mailboxForRoles, canSendEmail } from "@/lib/mailboxes";
import { sendEmail } from "@/lib/mailer";
import { toMessageDTO, replySubject } from "@/lib/messages";
import { getObjectBuffer, headObject } from "@/lib/storage";
import { sanitizeEmailHtml, extractCidImageIds, buildInlineImageAttachments } from "@/lib/mail-html";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const sendSchema = z.object({
  guestId: z.string().uuid(),
  enquiryId: z.string().uuid().optional(),
  subject: z.string().optional(),
  body: z.string().min(1, "Message body is required"),
  html: z.string().optional(),
  inReplyToMessageId: z.string().uuid().optional(),
  /** A Document already created via /api/files/upload-url + /confirm — attached
   * to the outbound email and left in place so it stays visible in the lead's
   * Documents tab. */
  attachmentDocumentId: z.string().uuid().optional(),
});

/**
 * POST /api/messages/email — send an email to a guest from the caller's
 * role mailbox (sales reps → sales mailbox, doctor → doctor mailbox), persist it
 * to the guest-level thread, and log it. Threads via In-Reply-To/References.
 */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!canSendEmail(ctx.roles)) {
      throw new ApiError("FORBIDDEN", "You cannot send email", 403);
    }
    const mailbox = mailboxForRoles(ctx.roles);
    if (!mailbox || !mailbox.configured) {
      throw new ApiError(
        "NO_MAILBOX",
        "No email mailbox is configured for your role yet.",
        400,
      );
    }

    const input = sendSchema.parse(await req.json());

    const guest = await prisma.guest.findFirst({
      where: { id: input.guestId, deletedAt: null },
      select: { id: true, email: true },
    });
    if (!guest) throw new ApiError("NOT_FOUND", "Guest not found", 404);
    if (!guest.email) {
      throw new ApiError("NO_EMAIL", "This guest has no email address.", 400);
    }

    // F15: a leads.ownOnly sender (Reception) may only email guests they own —
    // mirror the enquiry-ownership predicate used by the bulk sender. Callers
    // with leads.manage, and the doctor mailbox (no leads.ownOnly), are unaffected.
    if (can(ctx.roles, "leads.ownOnly") && !can(ctx.roles, "leads.manage")) {
      const owned = await prisma.enquiry.findFirst({
        where: { guestId: guest.id, assignedToSub: ctx.sub },
        select: { id: true },
      });
      if (!owned) {
        throw new ApiError("FORBIDDEN", "You can only email guests assigned to you.", 403);
      }
    }

    // Threading: chain off the message being replied to.
    let inReplyTo: string | null = null;
    let references: string[] = [];
    let prevSubject: string | null = null;
    if (input.inReplyToMessageId) {
      const prev = await prisma.message.findFirst({
        where: { id: input.inReplyToMessageId, guestId: guest.id, mailboxId: mailbox.id },
      });
      if (prev?.messageId) {
        inReplyTo = prev.messageId;
        references = [...prev.references, prev.messageId];
        prevSubject = prev.subject;
      }
    }

    const subject =
      input.subject?.trim() ||
      (input.inReplyToMessageId ? replySubject(prevSubject) : "Message from Trē Wellness");

    const html = input.html ? sanitizeEmailHtml(input.html) : undefined;

    // The attachment is a Document already created by the upload-url/confirm
    // flow (so it's already visible in the guest/enquiry's Documents tab) —
    // only fetch its bytes here to hand to nodemailer. Scoped to this guest
    // so a caller can't attach someone else's document.
    let attachments: { filename: string; content: Buffer; contentType?: string; cid?: string }[] | undefined;
    if (input.attachmentDocumentId) {
      const doc = await prisma.document.findFirst({
        where: { id: input.attachmentDocumentId, guestId: guest.id },
      });
      if (!doc) throw new ApiError("NOT_FOUND", "Attachment not found", 404);
      // F38: HEAD the object before buffering — a multi-GB object would OOM the
      // pod via Buffer.concat. Cap at ~20MB (headroom under Gmail's 25MB limit).
      const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
      const head = await headObject(doc.storageKey);
      if (head.contentLength > MAX_ATTACHMENT_BYTES) {
        throw new ApiError(
          "PAYLOAD_TOO_LARGE",
          "Attachment exceeds the 20MB email limit",
          413,
        );
      }
      const content = await getObjectBuffer(doc.storageKey);
      attachments = [{ filename: doc.filename, content, contentType: doc.mimeType }];
    }

    // Images inserted via the rich-text editor's "insert image" button are
    // referenced in the html as <img src="cid:{documentId}"> rather than a
    // signed/public URL — resolve those into real inline MIME parts here,
    // scoped to this guest the same way the explicit attachment is.
    const inlineImages = await buildInlineImageAttachments(extractCidImageIds(html), guest.id);
    if (inlineImages.length) attachments = [...(attachments ?? []), ...inlineImages];

    // Persist first as "sending", then update — so a failed send still shows
    // in the thread with a retry affordance.
    const base = {
      guestId: guest.id,
      enquiryId: input.enquiryId ?? null,
      mailboxId: mailbox.id,
      channel: "email" as const,
      direction: "outbound" as const,
      subject,
      body: input.body,
      bodyHtml: html ?? null,
      fromEmail: mailbox.address,
      toEmail: guest.email,
      inReplyTo,
      references,
      attachmentDocumentId: input.attachmentDocumentId ?? null,
    };

    try {
      const res = await sendEmail(mailbox, {
        to: guest.email,
        subject,
        text: input.body,
        html,
        inReplyTo,
        references,
        attachments,
      });
      const msg = await prisma.message.create({
        data: { ...base, messageId: res.messageId, status: "sent" },
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
          metadata: { channel: "email", mailbox: mailbox.id, to: guest.email },
        },
      });
      return ok(toMessageDTO(msg), undefined, 201);
    } catch (err) {
      logger.error({ err, guestId: guest.id, mailbox: mailbox.id }, "email send failed");
      const msg = await prisma.message.create({
        data: {
          ...base,
          status: "failed",
          errorDetail: err instanceof Error ? err.message : "send failed",
        },
        include: { attachmentDocument: true },
      });
      // Surface the failed message (200) so the UI can show it + offer retry.
      return ok(toMessageDTO(msg));
    }
  });
}
