/** POST /api/sheet-check/sources — add a sheet by its Google Sheets link. */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { createSource } from "@/lib/sheet-check";
import { parseSheetUrl } from "@/lib/google-sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  sheetUrl: z.string().trim().min(1).max(500),
  name: z.string().trim().max(120).nullable().optional(),
  campaignLabel: z.string().trim().max(120).nullable().optional(),
});

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.manage")) throw new ApiError("FORBIDDEN", "Admin/Manager only", 403);
    const input = schema.parse(await req.json());
    if (!parseSheetUrl(input.sheetUrl)) {
      throw new ApiError("VALIDATION_ERROR", "Paste the full Google Sheets link (docs.google.com/spreadsheets/d/…)", 400);
    }
    const source = await createSource(input, ctx.sub);
    return ok({ id: source.id }, undefined, 201);
  });
}
