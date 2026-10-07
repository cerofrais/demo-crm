/**
 * PATCH  /api/admin/email-autoreplies/:id — edit or enable/disable one.
 * DELETE /api/admin/email-autoreplies/:id — remove one.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAnyPermission } from "@/lib/api";
import { updateEmailAutoReply, deleteEmailAutoReply } from "@/lib/email-autoreply";

export const dynamic = "force-dynamic";

const MINUTE = z.number().int().min(0).max(1439).nullable().optional();

const patchSchema = z.object({
  subjectTerms: z.array(z.string().max(200)).max(20).optional(),
  bodyTerms: z.array(z.string().max(500)).max(20).optional(),
  termMatch: z.enum(["any", "all"]).optional(),
  subject: z.string().max(200).nullable().optional(),
  replyText: z.string().min(1).max(10_000).optional(),
  attachmentDocumentIds: z.array(z.string().uuid()).max(10).optional(),
  // Tag put on the lead when the rule matches; null or "" removes it.
  tagOnMatch: z.string().max(60).nullable().optional(),
  enabled: z.boolean().optional(),
  activeFromMin: MINUTE,
  activeToMin: MINUTE,
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    await requireAnyPermission(["leads.manage", "whatsapp.manage"]);
    const input = patchSchema.parse(await req.json());
    return ok(await updateEmailAutoReply(params.id, input));
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    await requireAnyPermission(["leads.manage", "whatsapp.manage"]);
    await deleteEmailAutoReply(params.id);
    return ok({ id: params.id, deleted: true });
  });
}
