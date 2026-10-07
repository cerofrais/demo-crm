/**
 * GET  /api/admin/email-autoreplies — trigger-word auto-replies for inbound email.
 * POST /api/admin/email-autoreplies — add one.
 *
 * Mirrors the WhatsApp auto-reply API; the safety that makes this one
 * different lives in lib/email-autoreply.ts, not here.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAnyPermission } from "@/lib/api";
import { listEmailAutoReplies, createEmailAutoReply } from "@/lib/email-autoreply";

export const dynamic = "force-dynamic";

const MINUTE = z.number().int().min(0).max(1439).nullable().optional();

const createSchema = z.object({
  mailboxId: z.enum(["sales", "doctor"]).default("sales"),
  subjectTerms: z.array(z.string().max(200)).max(20).optional(),
  bodyTerms: z.array(z.string().max(500)).max(20).optional(),
  termMatch: z.enum(["any", "all"]).optional(),
  subject: z.string().max(200).nullable().optional(),
  replyText: z.string().min(1, "A reply needs some text").max(10_000),
  attachmentDocumentIds: z.array(z.string().uuid()).max(10).optional(),
  // Tag put on the lead when the rule matches; null or "" removes it.
  tagOnMatch: z.string().max(60).nullable().optional(),
  activeFromMin: MINUTE,
  activeToMin: MINUTE,
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireAnyPermission(["leads.manage", "templates.view", "whatsapp.manage", "whatsapp.view"]);
    const mailboxId = req.nextUrl.searchParams.get("mailboxId") ?? undefined;
    return ok({ items: await listEmailAutoReplies(mailboxId) });
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAnyPermission(["leads.manage", "whatsapp.manage"]);
    const input = createSchema.parse(await req.json());
    return ok(await createEmailAutoReply({ ...input, createdBy: ctx.sub }), undefined, 201);
  });
}
