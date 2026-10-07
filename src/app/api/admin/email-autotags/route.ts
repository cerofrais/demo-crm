/**
 * GET  /api/admin/email-autotags — rules that tag a lead from an inbound email.
 * POST /api/admin/email-autotags — add one.
 *
 * Same permissions as the email auto-replies they sit beside.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAnyPermission, ApiError } from "@/lib/api";
import { listEmailAutoTags, createEmailAutoTag } from "@/lib/email-auto-tag";
import { slugifyTag } from "@/lib/lead-tags";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  mailboxId: z.enum(["sales", "doctor"]).default("sales"),
  subjectTerms: z.array(z.string().max(200)).max(20).optional(),
  bodyTerms: z.array(z.string().max(500)).max(20).optional(),
  termMatch: z.enum(["any", "all"]).optional(),
  tag: z.string().min(1).max(64),
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireAnyPermission(["leads.manage", "templates.view", "whatsapp.manage", "whatsapp.view"]);
    const mailboxId = req.nextUrl.searchParams.get("mailboxId") ?? undefined;
    return ok({ items: await listEmailAutoTags(mailboxId) });
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAnyPermission(["leads.manage", "whatsapp.manage"]);
    const input = createSchema.parse(await req.json());
    if (!slugifyTag(input.tag)) {
      throw new ApiError("VALIDATION_ERROR", "That tag has no usable letters or numbers", 400);
    }
    // A rule with no terms would never match anything — refuse it rather than
    // store a rule that looks active and does nothing.
    const terms = [...(input.subjectTerms ?? []), ...(input.bodyTerms ?? [])];
    if (!terms.some((t) => t.trim())) {
      throw new ApiError("VALIDATION_ERROR", "Add at least one word to match in the subject or body", 400);
    }
    return ok(await createEmailAutoTag({ ...input, createdBy: ctx.sub }), undefined, 201);
  });
}
