import type { Message, Document } from "@prisma/client";
import { prisma } from "./prisma";
import type { MessageDTO } from "./types";

type MessageWithAttachment = Message & { attachmentDocument: Document | null };

export function toMessageDTO(
  m: MessageWithAttachment,
  fromLabel: string | null = null,
  replyTo: MessageDTO["replyTo"] = null,
): MessageDTO {
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
    replyTo,
  };
}

/**
 * Resolves each message's quoted-reply pointer to the message it quotes.
 *
 * `inReplyTo` holds the *provider's* id (WhatsApp's stanzaId), so the lookup
 * is against `externalId`, not the primary key. Batched into one query rather
 * than one per message. A pointer that resolves to nothing is normal and left
 * null — WhatsApp allows replying to a message older than anything we stored,
 * and to messages in chats the CRM never saw.
 */
export async function resolveReplyTargets(
  rows: Pick<Message, "inReplyTo">[],
): Promise<Map<string, NonNullable<MessageDTO["replyTo"]>>> {
  const wanted = [...new Set(rows.map((m) => m.inReplyTo).filter((v): v is string => !!v))];
  if (!wanted.length) return new Map();

  const quoted = await prisma.message.findMany({
    where: { externalId: { in: wanted } },
    select: { id: true, externalId: true, body: true, direction: true },
  });

  const byExternalId = new Map<string, NonNullable<MessageDTO["replyTo"]>>();
  for (const q of quoted) {
    if (!q.externalId) continue;
    byExternalId.set(q.externalId, {
      id: q.id,
      // Trimmed here rather than in the UI so the payload stays small on a
      // thread where every message quotes a long one.
      body: q.body.length > 180 ? `${q.body.slice(0, 180)}…` : q.body,
      direction: q.direction,
    });
  }
  return byExternalId;
}

/** "Re: foo" without stacking "Re: Re:". */
export function replySubject(subject?: string | null): string {
  const s = (subject ?? "").trim();
  if (!s) return "Re:";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
