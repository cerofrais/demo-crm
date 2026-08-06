/**
 * GET   /api/admin/call-routing — read the inbound-call routing scope.
 * PATCH /api/admin/call-routing — set which role(s) inbound calls route to.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, requireAnyPermission } from "@/lib/api";
import { getCallRoutingSettings, setCallRoutingSettings } from "@/lib/calls";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  scope: z.enum(["reception", "sales", "reception_sales", "all"]),
});

export async function GET() {
  return handle(async () => {
    await requireAnyPermission(["users.manage", "users.view"]);
    return ok(await getCallRoutingSettings());
  });
}

export async function PATCH(req: NextRequest) {
  return handle(async () => {
    await requirePermission("users.manage");
    const { scope } = patchSchema.parse(await req.json());
    return ok(await setCallRoutingSettings(scope));
  });
}
