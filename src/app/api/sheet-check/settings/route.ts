/** PUT /api/sheet-check/settings — schedule, recipients, and whether to push. */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { saveSettings } from "@/lib/sheet-check";

export const dynamic = "force-dynamic";

const schema = z.object({
  enabled: z.boolean(),
  intervalDays: z.number().int().min(1, "At least every 1 day").max(30, "At most every 30 days"),
  recipients: z.array(z.string().trim().email("One of the email addresses isn't valid")).max(20),
  pushMissing: z.boolean(),
});

export async function PUT(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.manage")) throw new ApiError("FORBIDDEN", "Admin/Manager only", 403);
    return ok(await saveSettings(schema.parse(await req.json()), ctx.sub));
  });
}
