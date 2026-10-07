import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { DOCTOR_REVIEW_TITLE_PREFIX, withRnrProgress, withLostRequestPending, withOpenTasks } from "@/lib/tasks";
import { toEnquiryDTO, withCurrentAssigneeName } from "@/lib/enquiries";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  decision: z.enum(["accepted", "rejected", "needs_phone_consult"]),
  note: z.string().max(500).optional(),
});

// PATCH /api/enquiries/:id/doctor-decision — Doctor's Accept/Reject/Needs-
// phone-consult call on a consultation-stage lead. Doctor-only; also marks
// the matching review task done.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requirePermission("leads.doctorDecision");
    const current = await prisma.enquiry.findUnique({ where: { id: params.id } });
    if (!current || current.deletedAt) throw new ApiError("NOT_FOUND", "Enquiry not found", 404);
    if (current.stage !== "doctor_consultation") {
      throw new ApiError("BAD_REQUEST", "Lead is not in Doctor Consultation", 400);
    }

    const { decision, note } = patchSchema.parse(await req.json());

    const updated = await prisma.enquiry.update({
      where: { id: params.id },
      data: {
        doctorDecision: decision,
        doctorDecisionAt: new Date(),
        doctorDecisionBySub: ctx.sub,
        doctorDecisionNote: note ?? null,
      },
      include: { guest: true },
    });

    await prisma.task.updateMany({
      where: {
        enquiryId: params.id,
        status: "open",
        kind: "doctor_review",
        title: { startsWith: DOCTOR_REVIEW_TITLE_PREFIX },
      },
      data: { status: "done" },
    });

    await prisma.activity.create({
      data: {
        enquiryId: updated.id,
        guestId: updated.guest.id,
        actorSub: ctx.sub,
        actorRole: ctx.roles[0] ?? "STAFF",
        actorName: ctx.name,
        actionType: "doctor_decision",
        metadata: { decision, note: note ?? null },
      },
    });

    return ok(await withOpenTasks(await withLostRequestPending(await withRnrProgress(await withCurrentAssigneeName(toEnquiryDTO(updated))))));
  });
}
