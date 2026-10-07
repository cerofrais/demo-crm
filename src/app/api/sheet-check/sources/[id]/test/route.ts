/** POST /api/sheet-check/sources/:id/test — read the sheet, change nothing. */
import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { canAny } from "@/lib/rbac";
import { testSource } from "@/lib/sheet-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!canAny(ctx.roles, ["leads.manage", "lead-assignment.view"])) throw new ApiError("FORBIDDEN", "No access", 403);
    try {
      return ok(await testSource(params.id));
    } catch (err) {
      throw new ApiError("SHEET_READ_FAILED", err instanceof Error ? err.message : "Couldn't read the sheet", 400);
    }
  });
}
