/**
 * The shape of the template folder tree — shared by the server, the Templates
 * page and the send-time picker, with no DB imports so all three agree.
 *
 * Folders nest, which is the whole reason this file exists: a flat list can be
 * grouped with a map, but a tree needs its order, its depth and its paths
 * worked out in one place, and a move needs to be checked for the one thing
 * that silently destroys a tree — a folder made its own ancestor.
 */

export const OTHERS_FOLDER = "Others";

/** Longest folder name that still reads as a heading in a narrow picker. */
export const FOLDER_NAME_MAX = 60;

/** How deep folders may nest. Deep enough to be useful, shallow enough to see. */
export const MAX_FOLDER_DEPTH = 4;

export interface FolderDTO {
  id: string;
  channel: "email" | "whatsapp";
  name: string;
  parentId: string | null;
  /** Templates filed directly in this folder (not in its children). */
  templateCount: number;
}

export interface FolderNode extends FolderDTO {
  children: FolderNode[];
  /** 0 for a top-level folder. */
  depth: number;
  /** "Detox / Pricing shared". */
  path: string;
  /** This folder's templates plus everything in its children. */
  totalCount: number;
}

/** Tidy a folder name typed by a person; empty becomes null. */
export function normalizeFolderName(input: string | null | undefined): string | null {
  const cleaned = (input ?? "").replace(/\s+/g, " ").trim().slice(0, FOLDER_NAME_MAX);
  return cleaned || null;
}

/**
 * Build the tree for one channel, A→Z at every level, with "Others" last.
 *
 * "Others" is where templates nobody filed ended up, so it is the one folder
 * that is not about the work — it belongs at the bottom of the list, not in
 * the middle of it under O.
 */
export function buildFolderTree(folders: FolderDTO[]): FolderNode[] {
  const byParent = new Map<string | null, FolderDTO[]>();
  for (const f of folders) {
    const siblings = byParent.get(f.parentId) ?? [];
    siblings.push(f);
    byParent.set(f.parentId, siblings);
  }

  const sortSiblings = (a: FolderDTO, b: FolderDTO) => {
    if (a.name === OTHERS_FOLDER) return 1;
    if (b.name === OTHERS_FOLDER) return -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  };

  const seen = new Set<string>();
  const build = (parentId: string | null, depth: number, parentPath: string): FolderNode[] =>
    [...(byParent.get(parentId) ?? [])].sort(sortSiblings).flatMap((f) => {
      // A cycle in the data would otherwise recurse forever; one row's worth
      // of corruption should not take a page down.
      if (seen.has(f.id)) return [];
      seen.add(f.id);
      const path = parentPath ? `${parentPath} / ${f.name}` : f.name;
      const children = build(f.id, depth + 1, path);
      return [
        {
          ...f,
          children,
          depth,
          path,
          totalCount: f.templateCount + children.reduce((n, c) => n + c.totalCount, 0),
        },
      ];
    });

  return build(null, 0, "");
}

/** The tree as a flat list, parents before their children — for selects. */
export function flattenTree(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap((n) => [n, ...flattenTree(n.children)]);
}

/** "Detox / Pricing shared" for one folder id. */
export function folderPath(folders: FolderDTO[], folderId: string | null): string | null {
  if (!folderId) return null;
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  let current = byId.get(folderId);
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    parts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return parts.length ? parts.join(" / ") : null;
}

/** Every folder beneath this one, however deep. */
export function descendantIds(folders: FolderDTO[], folderId: string): string[] {
  const out: string[] = [];
  const queue = [folderId];
  const guard = new Set<string>([folderId]);
  while (queue.length) {
    const id = queue.shift()!;
    for (const f of folders) {
      if (f.parentId === id && !guard.has(f.id)) {
        guard.add(f.id);
        out.push(f.id);
        queue.push(f.id);
      }
    }
  }
  return out;
}

/** How deep a folder sits; 0 at the top level. */
export function depthOf(folders: FolderDTO[], folderId: string | null): number {
  let depth = 0;
  const byId = new Map(folders.map((f) => [f.id, f]));
  let current = folderId ? byId.get(folderId) : undefined;
  const guard = new Set<string>();
  while (current?.parentId && !guard.has(current.id)) {
    guard.add(current.id);
    depth++;
    current = byId.get(current.parentId);
  }
  return depth;
}

export interface PathGroup<T> {
  /** "Detox / Pricing shared", or null for anything not in a folder. */
  path: string | null;
  templates: T[];
}

/**
 * Templates grouped by the folder path they carry, for a send-time picker.
 *
 * The picker is read while someone is mid-message, so the order is the order
 * on the Templates page: folders A→Z, "Others" after them, and anything with
 * no folder at the very end.
 */
export function groupTemplatesByPath<T extends { folderPath: string | null }>(templates: T[]): PathGroup<T>[] {
  const groups = new Map<string, PathGroup<T>>();
  for (const t of templates) {
    const key = t.folderPath ?? "";
    const existing = groups.get(key);
    if (existing) existing.templates.push(t);
    else groups.set(key, { path: t.folderPath, templates: [t] });
  }
  const rank = (path: string | null) => {
    if (path === null) return 2;
    return path === OTHERS_FOLDER || path.endsWith(` / ${OTHERS_FOLDER}`) ? 1 : 0;
  };
  return [...groups.values()].sort((a, b) => {
    const d = rank(a.path) - rank(b.path);
    if (d !== 0) return d;
    return (a.path ?? "").localeCompare(b.path ?? "", undefined, { sensitivity: "base" });
  });
}

export type MoveRefusal = "self" | "descendant" | "channel" | "depth" | "missing" | null;

/**
 * Why a folder may not move under a given parent — null when it may.
 *
 * The one that matters is "descendant": dragging a folder into its own child
 * detaches both from the tree, and nothing on the page would ever show them
 * again. The rest keep the tree legible rather than correct.
 */
export function checkFolderMove(
  folders: FolderDTO[],
  folderId: string,
  newParentId: string | null,
): MoveRefusal {
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) return "missing";
  if (newParentId === null) return null;
  if (newParentId === folderId) return "self";

  const parent = folders.find((f) => f.id === newParentId);
  if (!parent) return "missing";
  if (parent.channel !== folder.channel) return "channel";
  if (descendantIds(folders, folderId).includes(newParentId)) return "descendant";

  const subtreeDepth = (id: string): number => {
    const kids = folders.filter((f) => f.parentId === id);
    return kids.length ? 1 + Math.max(...kids.map((k) => subtreeDepth(k.id))) : 0;
  };
  if (depthOf(folders, newParentId) + 1 + subtreeDepth(folderId) >= MAX_FOLDER_DEPTH) return "depth";

  return null;
}

export const MOVE_REFUSAL_MESSAGE: Record<Exclude<MoveRefusal, null>, string> = {
  self: "A folder cannot be put inside itself.",
  descendant: "A folder cannot be moved into one of its own folders.",
  channel: "Email and WhatsApp folders are kept apart.",
  depth: `Folders can be ${MAX_FOLDER_DEPTH} deep at most.`,
  missing: "That folder no longer exists.",
};
