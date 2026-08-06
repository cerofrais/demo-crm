import { prisma } from "./prisma";
import type { MessageTemplateChannel, MessageTemplateDTO } from "./message-templates";

function toDTO(t: {
  id: string;
  channel: string;
  name: string;
  subject: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}): MessageTemplateDTO {
  return {
    id: t.id,
    channel: t.channel as MessageTemplateChannel,
    name: t.name,
    subject: t.subject,
    body: t.body,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export async function listMessageTemplates(channel?: MessageTemplateChannel): Promise<MessageTemplateDTO[]> {
  const rows = await prisma.messageTemplate.findMany({
    where: channel ? { channel } : undefined,
    orderBy: [{ channel: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toDTO);
}

export async function createMessageTemplate(input: {
  channel: MessageTemplateChannel;
  name: string;
  subject?: string | null;
  body: string;
  createdBy: string;
}): Promise<MessageTemplateDTO> {
  const row = await prisma.messageTemplate.create({
    data: {
      channel: input.channel,
      name: input.name,
      subject: input.channel === "email" ? (input.subject ?? null) : null,
      body: input.body,
      createdBy: input.createdBy,
    },
  });
  return toDTO(row);
}

export async function updateMessageTemplate(
  id: string,
  input: { name?: string; subject?: string | null; body?: string },
): Promise<MessageTemplateDTO> {
  const row = await prisma.messageTemplate.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.subject !== undefined && { subject: input.subject }),
      ...(input.body !== undefined && { body: input.body }),
    },
  });
  return toDTO(row);
}

export async function deleteMessageTemplate(id: string): Promise<void> {
  await prisma.messageTemplate.delete({ where: { id } });
}
