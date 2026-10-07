/**
 * GET  /api/whatsapp/autotags?numberId=… — list auto-tag rules.
 * POST /api/whatsapp/autotags — create one. Same whatsapp.manage/.view split
 * as the auto-replies they sit beside.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, requireAnyPermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { listAutoTags, createAutoTag } from "@/lib/auto-tag";
import { slugifyTag } from "@/lib/lead-tags";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  numberId: z.string().uuid(),
  /** A word or a whole sentence — both are matched as a substring. */
  trigger: z.string().min(1).max(300),
  tag: z.string().min(1).max(64),
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireAnyPermission(["whatsapp.manage", "whatsapp.view"]);
    return ok(await listAutoTags(req.nextUrl.searchParams.get("numberId") ?? undefined));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requirePermission("whatsapp.manage");
    const input = createSchema.parse(await req.json());

    const number = await prisma.whatsAppNumber.findUnique({ where: { id: input.numberId } });
    if (!number) throw new ApiError("NOT_FOUND", "WhatsApp number not found", 404);

    // Reject a tag that slugifies to nothing ("!!!") here rather than storing
    // a rule that can never apply anything.
    if (!slugifyTag(input.tag)) {
      throw new ApiError("VALIDATION_ERROR", "That tag has no usable letters or numbers", 400);
    }
    return ok(await createAutoTag({ ...input, createdBy: ctx.sub }), undefined, 201);
  });
}
