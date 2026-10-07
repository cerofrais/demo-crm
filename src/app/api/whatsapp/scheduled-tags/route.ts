/**
 * GET  /api/whatsapp/scheduled-tags?numberId=… — list the campaign windows.
 * POST /api/whatsapp/scheduled-tags — open one.
 *
 * Same whatsapp.manage/.view split as the keyword auto-tags they sit beside.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, requireAnyPermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { createScheduledTag, listScheduledTags } from "@/lib/scheduled-tag";
import { slugifyTag } from "@/lib/lead-tags";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  numberId: z.string().uuid(),
  tag: z.string().min(1).max(64),
  label: z.string().max(120).optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireAnyPermission(["whatsapp.manage", "whatsapp.view"]);
    return ok(await listScheduledTags(req.nextUrl.searchParams.get("numberId") ?? undefined));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requirePermission("whatsapp.manage");
    const input = createSchema.parse(await req.json());

    const number = await prisma.whatsAppNumber.findUnique({ where: { id: input.numberId } });
    if (!number) throw new ApiError("NOT_FOUND", "WhatsApp number not found", 404);
    if (!slugifyTag(input.tag)) {
      throw new ApiError("VALIDATION_ERROR", "That tag has no usable letters or numbers", 400);
    }
    // A window that ends before it starts tags nobody, silently, forever.
    if (input.endsAt <= input.startsAt) {
      throw new ApiError("VALIDATION_ERROR", "The window has to end after it starts.", 400);
    }
    return ok(await createScheduledTag({ ...input, createdBy: ctx.sub }), undefined, 201);
  });
}
