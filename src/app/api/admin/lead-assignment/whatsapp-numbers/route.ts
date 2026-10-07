/**
 * GET /api/admin/lead-assignment/whatsapp-numbers — configured per-number
 *     rules, plus every WhatsApp number we own (for the settings picker).
 * PUT /api/admin/lead-assignment/whatsapp-numbers — set, or with an empty
 *     eligibleSubs remove, the rule for one number.
 *
 * Routes a lead opened by an inbound WhatsApp message to whoever owns the
 * line it arrived on. Sibling of the campaigns route; same shape, same
 * permissions.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, requireAnyPermission } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import {
  getAllWhatsAppNumberAssignmentRules,
  setWhatsAppNumberAssignmentRule,
} from "@/lib/lead-assignment";

export const dynamic = "force-dynamic";

const putSchema = z.object({
  ourNumber: z.string().min(1),
  label: z.string().min(1),
  strategy: z.enum(["round_robin", "least_busy"]),
  eligibleSubs: z.array(z.string()).default([]),
});

export async function GET() {
  return handle(async () => {
    await requireAnyPermission(["leads.manage", "lead-assignment.view"]);
    const [rules, numbers] = await Promise.all([
      getAllWhatsAppNumberAssignmentRules(),
      // Every number, not just the connected ones: a line that is currently
      // disconnected still has history and will be reconnected, and dropping
      // it here would silently delete its rule from the UI's view.
      prisma.whatsAppNumber.findMany({
        where: { phoneNumber: { not: null } },
        orderBy: [{ isDefault: "desc" }, { label: "asc" }],
        select: { label: true, phoneNumber: true, integration: true, status: true },
      }),
    ]);
    const knownNumbers = numbers.map((n) => ({
      ourNumber: n.phoneNumber!,
      label: n.label,
      integration: n.integration,
      status: n.status,
    }));
    return ok({ rules, knownNumbers });
  });
}

export async function PUT(req: NextRequest) {
  return handle(async () => {
    await requirePermission("leads.manage");
    const { ourNumber, label, strategy, eligibleSubs } = putSchema.parse(await req.json());
    const rule = await setWhatsAppNumberAssignmentRule(ourNumber, label, strategy, eligibleSubs);
    return ok(rule);
  });
}
