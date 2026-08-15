/**
 * GET   /api/admin/lead-assignment — read all channels' settings.
 * PATCH /api/admin/lead-assignment — set one channel's strategy + eligible staff.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, requireAnyPermission } from "@/lib/api";
import { getAllLeadAssignmentSettings, setLeadAssignmentSettings } from "@/lib/lead-assignment";

export const dynamic = "force-dynamic";

// Keep in sync with LEAD_ASSIGNMENT_CATEGORIES in lib/lead-assignment.ts —
// this fell out of sync when "google_sheets" was added there, which broke
// saving that category's settings from the admin page.
const patchSchema = z.object({
  category: z.enum(["whatsapp", "email", "call", "google_sheets"]),
  strategy: z.enum(["round_robin", "least_busy"]),
  eligibleSubs: z.array(z.string()).default([]),
});

export async function GET() {
  return handle(async () => {
    await requireAnyPermission(["leads.manage", "lead-assignment.view"]);
    return ok(await getAllLeadAssignmentSettings());
  });
}

export async function PATCH(req: NextRequest) {
  return handle(async () => {
    await requirePermission("leads.manage");
    const { category, strategy, eligibleSubs } = patchSchema.parse(await req.json());
    return ok(await setLeadAssignmentSettings(category, strategy, eligibleSubs));
  });
}
