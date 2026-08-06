import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { slugifyTag } from "@/lib/lead-tags";
import { createTagSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

// GET /api/tags — shared custom-tag vocabulary (for the add-tag autocomplete)
export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view")) throw new ApiError("FORBIDDEN", "No access", 403);
    const tags = await prisma.tag.findMany({
      where: { category: "custom" },
      orderBy: { value: "asc" },
      select: { value: true },
    });
    return ok(tags.map((t) => t.value));
  });
}

// POST /api/tags — create a custom tag in the shared vocabulary (anyone)
export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view")) throw new ApiError("FORBIDDEN", "No access", 403);
    const { value } = createTagSchema.parse(await req.json());
    const slug = slugifyTag(value);
    if (!slug) throw new ApiError("VALIDATION_ERROR", "Invalid tag", 400);

    const tag = await prisma.tag.upsert({
      where: { value: slug },
      update: {},
      create: { value: slug, category: "custom", createdBy: ctx.sub },
    });
    return ok({ value: tag.value }, undefined, 201);
  });
}
