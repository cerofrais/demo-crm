/**
 * GET  /api/message-templates?channel=email|whatsapp — list templates.
 *      Readable by anyone who can send messages (the picker uses this), or
 *      by a read-only Viewer via the Message Templates admin page. Archived
 *      templates are left out unless ?includeArchived=1 — only the templates
 *      page asks for them, so no picker ever offers one.
 * POST /api/message-templates — create a template. Admin/Manager only.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, requireAnyPermission } from "@/lib/api";
import { listMessageTemplates, createMessageTemplate } from "@/lib/message-templates-service";

export const dynamic = "force-dynamic";

const channelSchema = z.enum(["email", "whatsapp"]);

const createSchema = z.object({
  channel: channelSchema,
  name: z.string().min(1).max(120),
  subject: z.string().max(300).optional(),
  body: z.string().min(1).max(10_000),
  folderId: z.string().uuid().nullish(),
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireAnyPermission(["messaging.send", "templates.view"]);
    const channelParam = req.nextUrl.searchParams.get("channel");
    const channel = channelParam ? channelSchema.parse(channelParam) : undefined;
    const includeArchived = req.nextUrl.searchParams.get("includeArchived") === "1";
    return ok(await listMessageTemplates(channel, { includeArchived }));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requirePermission("leads.manage");
    const input = createSchema.parse(await req.json());
    return ok(
      await createMessageTemplate({ ...input, folderId: input.folderId ?? undefined, createdBy: ctx.sub }),
      undefined,
      201,
    );
  });
}
