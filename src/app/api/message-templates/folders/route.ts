/**
 * GET  /api/message-templates/folders — the folder tree, flat, with counts.
 * POST /api/message-templates/folders — make a folder, optionally inside one.
 *
 * Reading is open to anyone who can pick a template when writing a message —
 * the folders are how they find one. Making, renaming and deleting stays with
 * whoever manages templates.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handle, ok, requireAnyPermission, requirePermission } from "@/lib/api";
import { createFolder, FolderError, listFolders } from "@/lib/template-folders-service";
import { FOLDER_NAME_MAX } from "@/lib/template-folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const channelSchema = z.enum(["email", "whatsapp"]);

const createSchema = z.object({
  channel: channelSchema,
  name: z.string().min(1, "Give the folder a name.").max(FOLDER_NAME_MAX),
  /** Omitted or null makes a folder at the top level of its channel. */
  parentId: z.string().uuid().nullish(),
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireAnyPermission(["messaging.send", "templates.view"]);
    const channelParam = req.nextUrl.searchParams.get("channel");
    const channel = channelParam ? channelSchema.parse(channelParam) : undefined;
    return ok(await listFolders(channel));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requirePermission("leads.manage");
    const input = createSchema.parse(await req.json());
    try {
      return ok(await createFolder({ ...input, createdBy: ctx.sub }), undefined, 201);
    } catch (err) {
      if (err instanceof FolderError) throw new ApiError("VALIDATION_ERROR", err.message, 400);
      throw err;
    }
  });
}
