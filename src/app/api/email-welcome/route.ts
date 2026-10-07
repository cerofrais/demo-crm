/**
 * GET /api/email-welcome — the onboarding welcome-email config.
 * PUT /api/email-welcome — update it (subject/body/toggle/schedule).
 *
 * Lives on the Auto-Reply page alongside the WhatsApp auto-replies, so it's
 * gated on the same whatsapp.manage/.view permissions — whoever curates one
 * kind of automatic guest-facing reply curates them all.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, requireAnyPermission, ApiError } from "@/lib/api";
import { getWelcomeEmailSetting, updateWelcomeEmailSetting } from "@/lib/welcome-email";
import { findBroadcastableDocument } from "@/lib/attachment-access";

export const dynamic = "force-dynamic";

const scheduleMin = z.number().int().min(0).max(1439).nullable();

const putSchema = z.object({
  enabled: z.boolean(),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(5000),
  activeFromMin: scheduleMin.optional(),
  activeToMin: scheduleMin.optional(),
  attachmentDocumentId: z.string().uuid().nullable().optional(),
});

export async function GET() {
  return handle(async () => {
    await requireAnyPermission(["whatsapp.manage", "whatsapp.view"]);
    return ok(await getWelcomeEmailSetting());
  });
}

export async function PUT(req: NextRequest) {
  return handle(async () => {
    const ctx = await requirePermission("whatsapp.manage");
    const input = putSchema.parse(await req.json());
    if (input.attachmentDocumentId) {
      const doc = await findBroadcastableDocument(input.attachmentDocumentId, ctx.roles);
      if (!doc) throw new ApiError("NOT_FOUND", "That file isn't available to attach", 404);
    }
    return ok(await updateWelcomeEmailSetting({ ...input, updatedBy: ctx.sub }));
  });
}
