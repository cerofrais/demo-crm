/**
 * GET /api/reports/cresent/settings — recipients, tags, on/off, and recent sends.
 * PUT /api/reports/cresent/settings — save them.
 *
 * Saving changes who receives lead contact details every week, so it needs
 * messaging.send on top of reports.allStaff — the read-only Viewer can look,
 * not change the list.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { getCresentSettings, listCresentSends, saveCresentSettings, SEND_HOUR_IST } from "@/lib/cresent-report";

export const dynamic = "force-dynamic";

const schema = z.object({
  enabled: z.boolean(),
  recipients: z.array(z.string().trim().email("One of the email addresses isn't valid")).max(20),
  tags: z.array(z.string().min(1).max(100)).max(30),
});

export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "reports.allStaff")) throw new ApiError("FORBIDDEN", "Admin/Manager only", 403);
    return ok({
      settings: await getCresentSettings(),
      sends: await listCresentSends(),
      sendHourIst: SEND_HOUR_IST,
    });
  });
}

export async function PUT(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "reports.allStaff") || !can(ctx.roles, "messaging.send")) {
      throw new ApiError("FORBIDDEN", "Admin/Manager only", 403);
    }
    const input = schema.parse(await req.json());
    if (input.enabled && (!input.recipients.length || !input.tags.length)) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "Add at least one email address and one tag before turning the weekly email on",
        400,
      );
    }
    return ok(await saveCresentSettings(input, ctx.sub));
  });
}
