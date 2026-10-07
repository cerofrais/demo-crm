/**
 * GET  /api/whatsapp/autoreplies?numberId=… — list auto-reply configs.
 * POST /api/whatsapp/autoreplies — create one. Same whatsapp.manage/.view
 * split as /api/admin/whatsapp/numbers — this is WhatsApp infra config.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, requireAnyPermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { listAutoReplies, createAutoReply } from "@/lib/whatsapp-autoreply";
import { findBroadcastableDocument } from "@/lib/attachment-access";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  numberId: z.string().uuid(),
  kind: z.enum(["trigger", "welcome"]).optional(),
  triggerWord: z.string().max(200).nullable().optional(),
  replyText: z.string().min(1).max(2000),
  activeFromMin: z.number().int().min(0).max(1439).nullable().optional(),
  activeToMin: z.number().int().min(0).max(1439).nullable().optional(),
  attachmentDocumentId: z.string().uuid().nullable().optional(),
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireAnyPermission(["whatsapp.manage", "whatsapp.view"]);
    const numberId = req.nextUrl.searchParams.get("numberId") ?? undefined;
    return ok(await listAutoReplies(numberId));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requirePermission("whatsapp.manage");
    const input = createSchema.parse(await req.json());

    const number = await prisma.whatsAppNumber.findUnique({ where: { id: input.numberId } });
    if (!number) throw new ApiError("NOT_FOUND", "WhatsApp number not found", 404);

    // One file goes to every guest this rule fires for, so it must be a
    // LIBRARY document — never one scoped to some other guest's record.
    if (input.attachmentDocumentId) {
      const doc = await findBroadcastableDocument(input.attachmentDocumentId, ctx.roles);
      if (!doc) throw new ApiError("NOT_FOUND", "That file isn't available to attach", 404);
    }

    return ok(await createAutoReply({ ...input, createdBy: ctx.sub }), undefined, 201);
  });
}
