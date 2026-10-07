/**
 * GET  /api/enquiries/[id]/merge?from=<enquiryId> — what a merge would move.
 * POST /api/enquiries/[id]/merge { sourceEnquiryId } — fold that lead into
 *   this one, keeping its messages, calls, notes, tasks and documents.
 *
 * `[id]` is always the SURVIVOR: the lead the rep is looking at is the one
 * they are keeping. The other card is soft-deleted, and every row that moved
 * is recorded so the merge can be undone (see /api/enquiries/merge/[id]/undo).
 *
 * Open to whoever works leads rather than to admins alone: duplicates are
 * noticed by the person working the queue, and making them wait for an admin
 * is what leads to a card being deleted instead.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handle, ok, requireSession } from "@/lib/api";
import { canMutateLeads, canWorkLeadStage } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { mergeLeads, previewLeadMerge } from "@/lib/lead-merge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ sourceEnquiryId: z.string().uuid() });

/** Both cards have to be ones this person could work in the first place. */
async function assertCanMerge(roles: Parameters<typeof canMutateLeads>[0], ids: string[]) {
  if (!canMutateLeads(roles)) throw new ApiError("FORBIDDEN", "You cannot merge leads.", 403);
  const leads = await prisma.enquiry.findMany({ where: { id: { in: ids } }, select: { id: true, stage: true } });
  if (leads.length !== ids.length) throw new ApiError("NOT_FOUND", "Lead not found", 404);
  for (const lead of leads) {
    if (!canWorkLeadStage(roles, lead.stage)) {
      throw new ApiError("FORBIDDEN", "One of those leads is at a stage you cannot work.", 403);
    }
  }
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    const ctx = await requireSession();
    const from = req.nextUrl.searchParams.get("from");
    if (!from) throw new ApiError("VALIDATION_ERROR", "Name the lead to merge in.", 400);
    await assertCanMerge(ctx.roles, [params.id, from]);
    return ok(await previewLeadMerge(from, params.id));
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    const ctx = await requireSession();
    const { sourceEnquiryId } = Body.parse(await req.json());
    await assertCanMerge(ctx.roles, [params.id, sourceEnquiryId]);

    const result = await mergeLeads({
      sourceEnquiryId,
      targetEnquiryId: params.id,
      actor: { sub: ctx.sub, role: ctx.roles[0] ?? "STAFF", name: ctx.name },
    });
    return ok(result);
  });
}
