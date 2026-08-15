/**
 * GET /api/admin/lead-assignment/campaigns — configured campaign rules, plus
 *     every campaignLabel actually in use (for the settings page's picker).
 * PUT /api/admin/lead-assignment/campaigns — set (or, with an empty
 *     eligibleSubs, remove) one campaign's assignment rule.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, requireAnyPermission } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import {
  getAllCampaignAssignmentRules,
  setCampaignAssignmentRule,
} from "@/lib/lead-assignment";

export const dynamic = "force-dynamic";

const putSchema = z.object({
  campaignLabel: z.string().min(1),
  strategy: z.enum(["round_robin", "least_busy"]),
  eligibleSubs: z.array(z.string()).default([]),
});

export async function GET() {
  return handle(async () => {
    await requireAnyPermission(["leads.manage", "lead-assignment.view"]);
    const [rules, campaignRows] = await Promise.all([
      getAllCampaignAssignmentRules(),
      prisma.enquiry.findMany({
        where: { campaignLabel: { not: null } },
        select: { campaignLabel: true },
        distinct: ["campaignLabel"],
        orderBy: { campaignLabel: "asc" },
      }),
    ]);
    const knownCampaigns = campaignRows.map((r) => r.campaignLabel).filter((c): c is string => !!c);
    return ok({ rules, knownCampaigns });
  });
}

export async function PUT(req: NextRequest) {
  return handle(async () => {
    await requirePermission("leads.manage");
    const { campaignLabel, strategy, eligibleSubs } = putSchema.parse(await req.json());
    const rule = await setCampaignAssignmentRule(campaignLabel, strategy, eligibleSubs);
    return ok(rule);
  });
}
