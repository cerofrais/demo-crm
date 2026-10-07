import { prisma } from "./prisma";
import { sanitizeEmailHtml } from "./mail-html";
import type { MessageTemplateChannel, MessageTemplateDTO } from "./message-templates";
import { folderPath, type FolderDTO } from "./template-folders";
import { defaultFolderId, listFolders } from "./template-folders-service";

/**
 * An email template body is HTML now — it is authored in the same rich
 * editor as a compose box, and it ends up on real outgoing mail — so it is
 * sanitized like every other HTML body that leaves the server.
 *
 * WhatsApp templates are plain text and pass through untouched: running an
 * HTML sanitizer over them would eat any literal angle bracket a rep typed.
 */
function cleanBody(channel: MessageTemplateChannel, body: string): string {
  return channel === "email" ? sanitizeEmailHtml(body) : body;
}

function toDTO(t: {
  id: string;
  channel: string;
  name: string;
  subject: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  folderId: string | null;
}, folders: FolderDTO[] = []): MessageTemplateDTO {
  return {
    id: t.id,
    channel: t.channel as MessageTemplateChannel,
    name: t.name,
    subject: t.subject,
    body: t.body,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    archivedAt: t.archivedAt?.toISOString() ?? null,
    folderId: t.folderId,
    folderPath: folderPath(folders, t.folderId),
  };
}

export async function listMessageTemplates(
  channel?: MessageTemplateChannel,
  opts: { includeArchived?: boolean } = {},
): Promise<MessageTemplateDTO[]> {
  const rows = await prisma.messageTemplate.findMany({
    where: {
      ...(channel ? { channel } : {}),
      // Archived templates are for the templates page only. Every picker
      // calls this without the flag, so an archived one can never be offered
      // to someone writing a message.
      ...(opts.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ channel: "asc" }, { createdAt: "asc" }],
  });
  // One read of the folder table for the whole list: every row needs its path,
  // and resolving each separately would be a query per template.
  const folders = await listFolders();
  return rows.map((r) => toDTO(r, folders));
}

export async function createMessageTemplate(input: {
  channel: MessageTemplateChannel;
  name: string;
  subject?: string | null;
  body: string;
  folderId?: string | null;
  createdBy: string;
}): Promise<MessageTemplateDTO> {
  const row = await prisma.messageTemplate.create({
    data: {
      channel: input.channel,
      name: input.name,
      subject: input.channel === "email" ? (input.subject ?? null) : null,
      body: cleanBody(input.channel, input.body),
      // Nothing is left unfiled: with no folder chosen it goes to the
      // channel's "Others", which is where the page shows it.
      folderId: input.folderId ?? (await defaultFolderId(input.channel)),
      createdBy: input.createdBy,
    },
  });
  return toDTO(row, await listFolders(row.channel as MessageTemplateChannel));
}

export async function updateMessageTemplate(
  id: string,
  input: { name?: string; subject?: string | null; body?: string; folderId?: string | null; archived?: boolean },
  actorSub?: string,
): Promise<MessageTemplateDTO> {
  // The channel is not in the patch — only the row knows it, and it is what
  // decides whether the body is HTML to be sanitized or text to be left alone.
  const existing = await prisma.messageTemplate.findUnique({
    where: { id },
    select: { channel: true },
  });
  const channel = (existing?.channel ?? "whatsapp") as MessageTemplateChannel;
  const row = await prisma.messageTemplate.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.subject !== undefined && { subject: input.subject }),
      ...(input.body !== undefined && { body: cleanBody(channel, input.body) }),
      ...(input.folderId !== undefined && { folderId: input.folderId }),
      ...(input.archived !== undefined && {
        archivedAt: input.archived ? new Date() : null,
        archivedBy: input.archived ? (actorSub ?? null) : null,
      }),
    },
  });
  return toDTO(row, await listFolders(row.channel as MessageTemplateChannel));
}

export async function deleteMessageTemplate(id: string): Promise<void> {
  await prisma.messageTemplate.delete({ where: { id } });
}
