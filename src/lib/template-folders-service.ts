/**
 * Server-side CRUD for template folders.
 *
 * The rule worth knowing: deleting a folder never deletes what is in it.
 * Templates and sub-folders move up to the folder's parent, or to "Others"
 * when it had none — a template that vanished with its folder would be work
 * someone wrote, gone, with no undo anywhere in this app.
 */
import { prisma } from "./prisma";
import {
  checkFolderMove,
  MOVE_REFUSAL_MESSAGE,
  normalizeFolderName,
  OTHERS_FOLDER,
  depthOf,
  MAX_FOLDER_DEPTH,
  type FolderDTO,
} from "./template-folders";
import type { MessageTemplateChannel } from "./message-templates";

export class FolderError extends Error {}

async function allFolders(channel?: MessageTemplateChannel): Promise<FolderDTO[]> {
  const rows = await prisma.messageTemplateFolder.findMany({
    where: channel ? { channel } : {},
    select: {
      id: true,
      channel: true,
      name: true,
      parentId: true,
      _count: { select: { templates: true } },
    },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel as MessageTemplateChannel,
    name: r.name,
    parentId: r.parentId,
    templateCount: r._count.templates,
  }));
}

export async function listFolders(channel?: MessageTemplateChannel): Promise<FolderDTO[]> {
  return allFolders(channel);
}

/** The channel's catch-all, made on demand so an empty channel has none. */
async function othersFolder(channel: MessageTemplateChannel): Promise<string> {
  const existing = await prisma.messageTemplateFolder.findFirst({
    where: { channel, name: OTHERS_FOLDER, parentId: null },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.messageTemplateFolder.create({
    data: { channel, name: OTHERS_FOLDER, createdBy: "system" },
    select: { id: true },
  });
  return created.id;
}

export async function createFolder(input: {
  channel: MessageTemplateChannel;
  name: string;
  parentId?: string | null;
  createdBy: string;
}): Promise<FolderDTO> {
  const name = normalizeFolderName(input.name);
  if (!name) throw new FolderError("Give the folder a name.");

  const parentId = input.parentId ?? null;
  if (parentId) {
    const parent = await prisma.messageTemplateFolder.findUnique({
      where: { id: parentId },
      select: { id: true, channel: true },
    });
    if (!parent) throw new FolderError("That folder no longer exists.");
    if (parent.channel !== input.channel) throw new FolderError(MOVE_REFUSAL_MESSAGE.channel);
    const folders = await allFolders(input.channel);
    if (depthOf(folders, parentId) + 1 >= MAX_FOLDER_DEPTH) throw new FolderError(MOVE_REFUSAL_MESSAGE.depth);
  }

  // Two folders of the same name under the same parent would be two drawers
  // nobody can tell apart.
  const clash = await prisma.messageTemplateFolder.findFirst({
    where: { channel: input.channel, parentId, name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (clash) throw new FolderError(`There is already a folder called "${name}" here.`);

  const row = await prisma.messageTemplateFolder.create({
    data: { channel: input.channel, name, parentId, createdBy: input.createdBy },
    select: { id: true, channel: true, name: true, parentId: true },
  });
  return { ...row, channel: row.channel as MessageTemplateChannel, templateCount: 0 };
}

export async function renameOrMoveFolder(
  id: string,
  input: { name?: string; parentId?: string | null },
): Promise<FolderDTO> {
  const folder = await prisma.messageTemplateFolder.findUnique({
    where: { id },
    select: { id: true, channel: true, name: true, parentId: true },
  });
  if (!folder) throw new FolderError("That folder no longer exists.");

  const name = input.name !== undefined ? normalizeFolderName(input.name) : folder.name;
  if (!name) throw new FolderError("Give the folder a name.");

  let parentId = folder.parentId;
  if (input.parentId !== undefined) {
    const folders = await allFolders();
    const refusal = checkFolderMove(folders, id, input.parentId);
    if (refusal) throw new FolderError(MOVE_REFUSAL_MESSAGE[refusal]);
    parentId = input.parentId;
  }

  const row = await prisma.messageTemplateFolder.update({
    where: { id },
    data: { name, parentId },
    select: { id: true, channel: true, name: true, parentId: true, _count: { select: { templates: true } } },
  });
  return {
    id: row.id,
    channel: row.channel as MessageTemplateChannel,
    name: row.name,
    parentId: row.parentId,
    templateCount: row._count.templates,
  };
}

export interface FolderDeletion {
  /** Where the contents went. */
  movedToId: string;
  movedTemplates: number;
  movedFolders: number;
}

/**
 * Delete a folder, keeping everything that was in it.
 *
 * Contents go to the folder's parent; a top-level folder's contents go to
 * "Others", which is made if this channel has none yet.
 */
export async function deleteFolder(id: string): Promise<FolderDeletion> {
  const folder = await prisma.messageTemplateFolder.findUnique({
    where: { id },
    select: { id: true, channel: true, parentId: true, name: true },
  });
  if (!folder) throw new FolderError("That folder no longer exists.");

  const channel = folder.channel as MessageTemplateChannel;
  const destination = folder.parentId ?? (await othersFolder(channel));
  if (destination === id) throw new FolderError("That folder cannot be deleted.");

  return prisma.$transaction(async (tx) => {
    const movedTemplates = await tx.messageTemplate.updateMany({
      where: { folderId: id },
      data: { folderId: destination },
    });
    const movedFolders = await tx.messageTemplateFolder.updateMany({
      where: { parentId: id },
      data: { parentId: folder.parentId },
    });
    await tx.messageTemplateFolder.delete({ where: { id } });
    return {
      movedToId: destination,
      movedTemplates: movedTemplates.count,
      movedFolders: movedFolders.count,
    };
  });
}

/** Where a new template goes when the page had no folder selected. */
export async function defaultFolderId(channel: MessageTemplateChannel): Promise<string> {
  return othersFolder(channel);
}
