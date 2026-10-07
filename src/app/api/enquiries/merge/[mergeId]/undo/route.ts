/**
 * POST /api/enquiries/merge/[mergeId]/undo — put a merge back.
 *
 * Every row the merge moved was written down, so this returns each one to the
 * lead it came from and brings the folded card back out of soft delete. The
 * point of keeping the record is that nobody has to be brave to merge.
 */
import { NextRequest } from "next/server";
import { handle, ok, requirePermission } from "@/lib/api";
import { undoLeadMerge } from "@/lib/lead-merge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: { mergeId: string } }) {
  return handle(async () => {
    const ctx = await requirePermission("leads.manage");
    await undoLeadMerge(params.mergeId, { sub: ctx.sub, role: ctx.roles[0] ?? "STAFF", name: ctx.name });
    return ok({ undone: true });
  });
}
