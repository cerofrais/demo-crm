import type { Message, Document } from "@prisma/client";
import type { MessageDTO } from "./types";

type MessageWithAttachment = Message & { attachmentDocument: Document | null };

export function toMessageDTO(m: MessageWithAttachment, fromLabel: string | null = null): MessageDTO {
  return {
    id: m.id,
    direction: m.direction,
    mailboxId: m.mailboxId,
    subject: m.subject,
    body: m.body,
    bodyHtml: m.bodyHtml,
    fromEmail: m.fromEmail,
    toEmail: m.toEmail,
    status: m.status,
    needsReview: m.needsReview,
    createdAt: m.createdAt.toISOString(),
    attachment: m.attachmentDocument
      ? {
          id: m.attachmentDocument.id,
          filename: m.attachmentDocument.filename,
          mimeType: m.attachmentDocument.mimeType,
        }
      : null,
    fromLabel,
    editedAt: m.editedAt?.toISOString() ?? null,
    deletedAt: m.deletedAt?.toISOString() ?? null,
  };
}

/** "Re: foo" without stacking "Re: Re:". */
export function replySubject(subject?: string | null): string {
  const s = (subject ?? "").trim();
  if (!s) return "Re:";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
