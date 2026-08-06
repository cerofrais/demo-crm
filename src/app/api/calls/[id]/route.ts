/**
 * PATCH /api/calls/[id] — update notes and/or tags on a call record.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

// F35: bound the payload — unbounded notes/tags let a caller stuff arbitrarily
// large blobs into the record.
const patchSchema = z.object({
  notes: z.string().max(4000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  // Link a previously-unmatched call (guestId was null — the "unattended
  // calls" tab) to a lead created from it, so it drops off that queue and
  // shows up in the new lead's own call history instead.
  guestId: z.string().uuid().optional(),
  enquiryId: z.string().uuid().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    // F11: use requireSession() (enforces session revocation) instead of raw auth().
    const ctx = await requireSession();

    const call = await prisma.call.findUnique({
      where: { id: params.id },
      select: { repKeycloakId: true, guestId: true, status: true, customerPhone: true },
    });
    if (!call) throw new ApiError("NOT_FOUND", "Call not found", 404);

    // F11: editing a call is ownership-scoped — managers (leads.manage) may edit
    // any call; everyone else only the calls they handled.
    const allowed = can(ctx.roles, "leads.manage") || call.repKeycloakId === ctx.sub;
    if (!allowed) throw new ApiError("FORBIDDEN", "Cannot edit this call", 403);

    const body = patchSchema.parse(await req.json());
    if (body.guestId !== undefined && call.guestId) {
      throw new ApiError("CONFLICT", "Call is already linked to a guest", 409);
    }

    const data: { notes?: string; tags?: string[]; guestId?: string; enquiryId?: string } = {};
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.tags !== undefined) data.tags = body.tags;
    if (body.guestId !== undefined) data.guestId = body.guestId;
    if (body.enquiryId !== undefined) data.enquiryId = body.enquiryId;

    const updated = await prisma.call.update({
      where: { id: params.id },
      data,
    });

    // Backfill the missed-call Activity entry on the lead just created from
    // this unattended call — otherwise a new lead's Activity tab has no
    // record of the missed call that brought it in, unlike an existing lead
    // which gets this written at the moment the call was actually missed
    // (see inbound-hangup's DialStatus handling).
    const missedStatuses = new Set(["no_answer", "voicemail", "failed"]);
    if (body.guestId && missedStatuses.has(call.status)) {
      await prisma.activity.create({
        data: {
          guestId: body.guestId,
          enquiryId: body.enquiryId ?? null,
          actorSub: "plivo-missed-call",
          actorRole: "system",
          actorName: "Missed call",
          actionType: "call_missed",
          metadata: { customerPhone: call.customerPhone, linkedFromUnattended: true },
        },
      }).catch(() => null);
    }

    return ok({ id: updated.id });
  });
}
