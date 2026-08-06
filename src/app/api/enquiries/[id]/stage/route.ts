import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can, canWorkLeadStage, isPostBookingStage, isAdmin } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toEnquiryDTO, withCurrentAssigneeName } from "@/lib/enquiries";
import { moveStageSchema } from "@/lib/validation";
import { createDoctorReviewTask, createFollowUpTasks, reassignTasksForEnquiry, withRnrProgress, withLostRequestPending } from "@/lib/tasks";
import { syncEnquiryTags } from "@/lib/tags-service";
import type { EnquiryStage } from "@prisma/client";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/enquiries/:id/stage — move a card between Kanban columns.
 * Drag-to-assign (Stories §1): if the card is unassigned, moving it assigns it
 * to the acting salesperson. Both the assignment and the stage change are
 * written to the Activity audit log.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    const { stage, boardPosition } = moveStageSchema.parse(await req.json());

    const current = await prisma.enquiry.findUnique({ where: { id: params.id } });
    if (!current) throw new ApiError("NOT_FOUND", "Enquiry not found", 404);

    const isOwner = current.assignedToSub === ctx.sub;
    const isUnassigned = current.assignedToSub === null;
    const allowed =
      can(ctx.roles, "leads.manage") ||
      (can(ctx.roles, "leads.ownOnly") &&
        (isOwner || isUnassigned) &&
        canWorkLeadStage(ctx.roles, current.stage));
    if (!allowed) throw new ApiError("FORBIDDEN", "Cannot move this lead", 403);

    // Lost/Dead is request-only for everyone, including Admin/Manager — a
    // direct drag/edit into this column is never allowed. Use
    // POST /api/enquiries/:id/request-lost, which opens a task any
    // Admin/Manager can approve (that's what actually moves the stage — see
    // PATCH /api/tasks/:id/decision).
    if (stage === "lost" && current.stage !== "lost") {
      throw new ApiError(
        "BAD_REQUEST",
        "Lost/Dead can't be set directly — use the Lost/Dead request button on the lead instead.",
        400,
      );
    }

    // Staff is Admin-only — checked explicitly rather than relying on
    // canWorkLeadStage alone, since a Manager's leads.manage already
    // short-circuits that check for every other stage.
    if (stage === "staff" && current.stage !== "staff" && !isAdmin(ctx.roles)) {
      throw new ApiError("FORBIDDEN", "Only Admin can move a lead to Staff", 403);
    }

    // Booking Confirmed (or a card dragged straight to Converted, skipping it
    // — the kanban doesn't enforce sequential order) is the Sales -> Reception
    // handoff point: the lead is auto-unassigned here (rather than the usual
    // drag-to-claim assigning the mover) so it lands back in the unassigned
    // queue for Reception to pick up, and "leads.preBookingOnly" (Sales)
    // loses access to it from here on (see canWorkLeadStage / the list
    // route's stage filter).
    const enteringPostBooking = isPostBookingStage(stage) && !isPostBookingStage(current.stage);
    const willAssign = isUnassigned && !enteringPostBooking;
    // A lead can still be moved OUT of Lost/Dead this way (e.g. reopening it
    // manually) — only entering is blocked above. Clear the auto-delete
    // clock so a later re-request/approval restarts it instead of reusing a
    // stale stamp.
    const leavingLost = stage !== "lost" && current.stage === "lost";

    const updated = await prisma.enquiry.update({
      where: { id: params.id },
      data: {
        stage: stage as EnquiryStage,
        boardPosition: boardPosition ?? 0,
        lastActivityAt: new Date(),
        ...(enteringPostBooking
          ? { assignedToSub: null, assignedToName: null }
          : willAssign
            ? { assignedToSub: ctx.sub, assignedToName: ctx.name }
            : {}),
        ...(leavingLost ? { lostAt: null } : {}),
      },
      include: { guest: true },
    });

    if (willAssign) {
      await prisma.activity.create({
        data: {
          enquiryId: updated.id,
          guestId: updated.guestId,
          actorSub: ctx.sub,
          actorRole: ctx.roles[0] ?? "STAFF",
          actorName: ctx.name,
          actionType: "assign",
          metadata: { to: ctx.name },
        },
      });
    } else if (enteringPostBooking && current.assignedToSub) {
      await prisma.activity.create({
        data: {
          enquiryId: updated.id,
          guestId: updated.guestId,
          actorSub: ctx.sub,
          actorRole: ctx.roles[0] ?? "STAFF",
          actorName: ctx.name,
          actionType: "assign",
          metadata: { from: current.assignedToName ?? "Unassigned", to: "Unassigned" },
        },
      });
    }

    if (current.stage !== stage) {
      await prisma.activity.create({
        data: {
          enquiryId: updated.id,
          guestId: updated.guestId,
          actorSub: ctx.sub,
          actorRole: ctx.roles[0] ?? "STAFF",
          actorName: ctx.name,
          actionType: "stage_change",
          metadata: { from: current.stage, to: stage },
        },
      });
    }

    // Reassignment (drag-to-claim, or auto-unassign into the post-booking
    // handoff) moves the lead's still-open tasks to the new owner too.
    if (updated.assignedToSub !== current.assignedToSub) {
      await reassignTasksForEnquiry(updated.id, updated.assignedToSub);
    }

    // Entering RNR kicks off the 6-2-1 follow-up reminders for the owner.
    if (stage === "rnr" && current.stage !== "rnr") {
      await createFollowUpTasks(updated.id, updated.assignedToSub ?? ctx.sub);
    }

    // Entering Doctor Consultation opens a review task any doctor can pick up.
    if (stage === "doctor_consultation" && current.stage !== "doctor_consultation") {
      await createDoctorReviewTask(updated.id, updated.guest.fullName, ctx.sub);
    }

    // Referral redemption: count it once, when the lead is first booked (§6.5).
    if (
      stage === "booking_confirmed" &&
      current.stage !== "booking_confirmed" &&
      current.referralCodeId
    ) {
      await prisma.referralCode.update({
        where: { id: current.referralCodeId },
        data: { redemptionCount: { increment: 1 } },
      });
    }

    // Persist tags (re-affirms source/age/revisit on the moved card).
    updated.tags = await syncEnquiryTags(updated.id);

    return ok(await withLostRequestPending(await withRnrProgress(await withCurrentAssigneeName(toEnquiryDTO(updated)))));
  });
}
