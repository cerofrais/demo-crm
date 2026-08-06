/**
 * GET   /api/admin/lead-deletion — read the auto-delete day count.
 * PATCH /api/admin/lead-deletion — set how many days after manager approval
 * a Dead lead sits before the background sweep soft-deletes it.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, requireAnyPermission } from "@/lib/api";
import { getLeadDeletionSettings, setLeadDeletionSettings } from "@/lib/lead-deletion";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ autoDeleteDays: z.number().int().min(1).max(365) });

export async function GET() {
  return handle(async () => {
    await requireAnyPermission(["users.manage", "users.view"]);
    return ok(await getLeadDeletionSettings());
  });
}

export async function PATCH(req: NextRequest) {
  return handle(async () => {
    await requirePermission("users.manage");
    const { autoDeleteDays } = patchSchema.parse(await req.json());
    return ok(await setLeadDeletionSettings(autoDeleteDays));
  });
}
