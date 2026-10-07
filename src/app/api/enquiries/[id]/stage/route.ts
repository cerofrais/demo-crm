import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can, canWorkLeadStage, isPostBookingStage, isAdmin } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { applyStageTransition } from "@/lib/stage-transition";
import { GUEST_WITH_HEALTH_COUNT, toEnquiryDTO, withCurrentAssigneeName } from "@/lib/enquiries";
import { affectsVisited, refreshGuestVisited } from "@/lib/guest-visits";
import { moveStageSchema } from "@/lib/validation";
import { reassignTasksForEnquiry, withRnrProgress, withLostRequestPending, withOpenTasks,
  createPaymentPendingTask,
  closePaymentPendingTasks,
  deleteTasksForEnquiry,
} from "@/lib/tasks";
import { syncEnquiryTags } from "@/lib/tags-service";
import { logger } from "@/lib/logger";
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
    // Filing a card as a non-lead means nobody works it again, so its open
    // follow-ups go with it — otherwise the RNR cadence keeps scheduling
    // calls against a spam submission. Same clean-up Lost/Dead gets on
    // approval; deletion-approval tasks are preserved either way, since one
    // of those is the audit record of a transition.
    const enteringNonLeads = stage === "non_leads" && current.stage !== "non_leads";

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
        ...(enteringNonLeads ? { needsAttention: false } : {}),
      },
      include: { guest: GUEST_WITH_HEALTH_COUNT },
    });

    // Booking Confirmed / Converted is what makes a guest a returning guest.
    if (affectsVisited(current.stage, stage)) {
      await refreshGuestVisited(updated.guestId);
    }

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

    // Best-effort: the card has already moved, and a lingering follow-up is
    // worth far less than the move failing after the fact.
    if (enteringNonLeads) {
      await deleteTasksForEnquiry(updated.id).catch((err) =>
        logger.error({ err, enquiryId: updated.id }, "non-leads: could not clear follow-up tasks"),
      );
    }

    // Reassignment (drag-to-claim, or auto-unassign into the post-booking
    // handoff) moves the lead's still-open tasks to the new owner too.
    if (updated.assignedToSub !== current.assignedToSub) {
      await reassignTasksForEnquiry(updated.id, updated.assignedToSub);
    }

    // The stage move itself: the activity row and every task it raises or
    // closes. Shared with the drawer's edit form — see lib/stage-transition.ts.
    await applyStageTransition({
      enquiryId: updated.id,
      guestId: updated.guestId,
      guestName: updated.guest.fullName,
      from: current.stage,
      to: stage as EnquiryStage,
      assignedToSub: updated.assignedToSub,
      referralCodeId: current.referralCodeId,
      actor: { sub: ctx.sub, role: ctx.roles[0] ?? "STAFF", name: ctx.name },
    });

    // Persist tags (re-affirms source/age/revisit on the moved card).
    updated.tags = await syncEnquiryTags(updated.id);

    return ok(await withOpenTasks(await withLostRequestPending(await withRnrProgress(await withCurrentAssigneeName(toEnquiryDTO(updated))))));
  });
}
