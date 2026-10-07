/**
 * GET /api/admin/lead-assignment/tags — configured tag rules, plus the tags
 *     actually in use, so the settings page can offer a picker rather than
 *     asking an admin to retype one exactly.
 * PUT /api/admin/lead-assignment/tags — set (or, with an empty eligibleSubs,
 *     remove) one tag's assignment rule.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, requireAnyPermission } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { ROUTABLE_SYSTEM_TAGS } from "@/lib/lead-tags";
import { getAllTagAssignmentRules, setTagAssignmentRule } from "@/lib/lead-assignment";

export const dynamic = "force-dynamic";

const putSchema = z.object({
  label: z.string().min(1).max(80),
  strategy: z.enum(["round_robin", "least_busy"]),
  eligibleSubs: z.array(z.string()).default([]),
  // Lower runs first when a lead carries several matching tags.
  priority: z.number().int().min(0).max(999).default(0),
});

export async function GET() {
  return handle(async () => {
    await requireAnyPermission(["leads.manage", "lead-assignment.view"]);
    const [rules, tagRows] = await Promise.all([
      getAllTagAssignmentRules(),
      // The vocabulary an admin can actually pick from. Tag rows rather than
      // a scan of every Enquiry.tags array — same list the tag editor uses.
      prisma.tag.findMany({ select: { value: true }, orderBy: { value: "asc" }, take: 500 }),
    ]);
    // System tags first: they are the ones with no other way in. Without
    // them the picker offered only admin-created tags, so a rule for foreign
    // numbers was impossible to express correctly — see ROUTABLE_SYSTEM_TAGS.
    const knownTags = [...new Set([...ROUTABLE_SYSTEM_TAGS, ...tagRows.map((t) => t.value)])];
    return ok({ rules, knownTags });
  });
}

export async function PUT(req: NextRequest) {
  return handle(async () => {
    await requirePermission("leads.manage");
    const { label, strategy, eligibleSubs, priority } = putSchema.parse(await req.json());
    return ok(await setTagAssignmentRule(label, strategy, eligibleSubs, priority));
  });
}
