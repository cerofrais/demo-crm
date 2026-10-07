import { NextRequest } from "next/server";
import { handle, ok, requireSession, requirePermission, ApiError } from "@/lib/api";
import {
  can,
  canMutateLeads,
  canViewLeadStage,
  canWorkLeadStage,
  isPostBookingStage,
  isAdmin,
} from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { applyStageTransition } from "@/lib/stage-transition";
import { GUEST_WITH_HEALTH_COUNT, toEnquiryDTO, withCurrentAssigneeName } from "@/lib/enquiries";
import { affectsVisited, refreshGuestVisited } from "@/lib/guest-visits";
import { updateEnquirySchema } from "@/lib/validation";
import {
  formatBookingChanges,
  summarizeBooking,
  type BookingDetails,
  type BookingDetailsPatch,
} from "@/lib/booking-details";
import { syncEnquiryTags } from "@/lib/tags-service";
import { reassignTasksForEnquiry, withRnrProgress, withLostRequestPending, withOpenTasks } from "@/lib/tasks";
import { logger } from "@/lib/logger";
import { deleteObject } from "@/lib/storage";
import { Prisma } from "@prisma/client";
import type { EnquiryStage } from "@prisma/client";
import { guestResetAfterHardDelete } from "@/lib/hard-delete-guest";

export const dynamic = "force-dynamic";

// GET /api/enquiries/:id — single lead detail, for deep-linking (e.g. a task
// card in Tasks & Reminders jumping straight to its lead). Same visibility
// rules as the list route: leads.manage sees anything, leads.ownOnly is
// scoped to own/unassigned, and canWorkLeadStage's stage-boundaries apply to
// everyone (Sales past Booking Confirmed, Doctor outside consultation, Staff
// being Admin-only).
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view")) throw new ApiError("FORBIDDEN", "No access to leads", 403);

    const enquiry = await prisma.enquiry.findFirst({
      where: { id: params.id, deletedAt: null },
      include: { guest: GUEST_WITH_HEALTH_COUNT },
    });
    if (!enquiry) throw new ApiError("NOT_FOUND", "Enquiry not found", 404);

    if (!can(ctx.roles, "leads.manage") && can(ctx.roles, "leads.ownOnly")) {
      const ownedOrUnassigned =
        enquiry.assignedToSub === ctx.sub || enquiry.assignedToSub === null;
      if (!ownedOrUnassigned) throw new ApiError("FORBIDDEN", "Cannot view this lead", 403);
    }
    if (!canViewLeadStage(ctx.roles, enquiry.stage)) {
      throw new ApiError("FORBIDDEN", "Cannot view this lead", 403);
    }

    return ok(await withOpenTasks(await withLostRequestPending(await withRnrProgress(await withCurrentAssigneeName(toEnquiryDTO(enquiry))))));
  });
}

// PATCH /api/enquiries/:id — update lead form fields (assignee, price, etc.)
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    const current = await prisma.enquiry.findUnique({ where: { id: params.id } });
    if (!current || current.deletedAt) throw new ApiError("NOT_FOUND", "Enquiry not found", 404);

    // Same rule as remarks/tasks — anyone who actually WORKS leads (manage,
    // ownOnly, or consultationOnly — not bare leads.view, which a read-only
    // Viewer/Staff-style role also holds) can edit its details, bounded by
    // the same stage-visibility rule as everything else. Reassigning the
    // owner is a separate, more sensitive action — stays leads.manage-only
    // below.
    const allowed = canMutateLeads(ctx.roles) && canWorkLeadStage(ctx.roles, current.stage);
    if (!allowed) throw new ApiError("FORBIDDEN", "Cannot edit this lead", 403);

    const input = updateEnquirySchema.parse(await req.json());

    // Same request-only rule as the kanban drag route — see its comment.
    if (input.stage === "lost" && current.stage !== "lost") {
      throw new ApiError(
        "BAD_REQUEST",
        "Lost/Dead can't be set directly — use the Lost/Dead request button on the lead instead.",
        400,
      );
    }

    // Same Admin-only rule as the kanban drag route — see its comment.
    if (input.stage === "staff" && current.stage !== "staff" && !isAdmin(ctx.roles)) {
      throw new ApiError("FORBIDDEN", "Only Admin can move a lead to Staff", 403);
    }

    // Booking Confirmed (or straight to Converted) is the Sales -> Reception
    // handoff point: auto-unassign here too (edit-form stage change), same as
    // the kanban drag route — takes precedence over any explicit assignedToSub
    // in this same request.
    const enteringPostBooking =
      input.stage !== undefined && isPostBookingStage(input.stage) && !isPostBookingStage(current.stage);

    // A stage move is NOT listed here: it gets its own `stage_change`
    // activity through applyStageTransition below, the same as a move made on
    // the board. Listing it in both places put the move in the timeline twice
    // and left the Activity Log's stage filter unable to find it in either.
    const changes: string[] = [];
    if (input.quotedPriceINR !== undefined && input.quotedPriceINR !== current.quotedPriceINR) {
      changes.push(
        `Quoted price: ${current.quotedPriceINR ?? "-"} -> ${input.quotedPriceINR ?? "-"}`,
      );
    }
    if (input.intakeNotes !== undefined && input.intakeNotes !== current.intakeNotes) {
      changes.push("Notes updated");
    }

    // Booking detail is diffed separately from `changes` above: it gets its
    // own Activity row so the timeline reads as a booking note rather than
    // being buried in a "Updated details: …" line alongside a phone edit.
    const bookingBefore: BookingDetails = {
      occupancy: current.occupancy,
      companionName: current.companionName,
      stayDays: current.stayDays,
      roomCount: current.roomCount,
      pricePerDayINR: current.pricePerDayINR,
      roomCategory: current.roomCategory,
    };
    const bookingPatch: BookingDetailsPatch = {
      occupancy: input.occupancy,
      companionName: input.companionName === "" ? null : input.companionName,
      stayDays: input.stayDays,
      roomCount: input.roomCount,
      pricePerDayINR: input.pricePerDayINR,
      roomCategory: input.roomCategory,
    };
    const bookingChanges = formatBookingChanges(bookingBefore, bookingPatch);
    const isReassignment =
      !enteringPostBooking &&
      input.assignedToSub !== undefined && input.assignedToSub !== current.assignedToSub;
    if (isReassignment) {
      const allowedToReassign = can(ctx.roles, "leads.manage");
      if (!allowedToReassign) throw new ApiError("FORBIDDEN", "Cannot reassign this lead", 403);
    }

    const currentGuest = await prisma.guest.findUnique({
      where: { id: current.guestId },
      select: { fullName: true, phone: true, email: true, city: true, gender: true },
    });
    if (!currentGuest) throw new ApiError("NOT_FOUND", "Guest not found", 404);

    if (input.fullName !== undefined && input.fullName !== currentGuest.fullName) {
      changes.push(`Name: ${currentGuest.fullName} -> ${input.fullName}`);
    }
    const nextPhone = input.phone === "" ? null : input.phone;
    if (input.phone !== undefined && nextPhone !== currentGuest.phone) {
      changes.push(`Phone: ${currentGuest.phone ?? "-"} -> ${nextPhone ?? "-"}`);
    }
    if (input.email !== undefined && (input.email || null) !== currentGuest.email) {
      changes.push(`Email: ${currentGuest.email ?? "-"} -> ${input.email || "-"}`);
    }
    if (input.city !== undefined && (input.city || null) !== currentGuest.city) {
      changes.push(`City: ${currentGuest.city ?? "-"} -> ${input.city || "-"}`);
    }
    if (input.gender !== undefined && (input.gender || null) !== currentGuest.gender) {
      changes.push(`Gender: ${currentGuest.gender ?? "-"} -> ${input.gender || "-"}`);
    }

    // A phone/email being changed to one that already belongs to a DIFFERENT
    // guest would die on the unique constraint inside the nested guest update
    // below — surfacing as a bare "Something went wrong" 500. Check first and
    // name the conflict so the rep knows it's a duplicate contact, not a
    // system failure. (The constraint still backstops the race window.)
    for (const [field, value] of [
      ["phone", nextPhone],
      ["email", input.email !== undefined ? input.email || null : undefined],
    ] as const) {
      if (value === undefined || value === null) continue;
      const other = await prisma.guest.findFirst({
        where: { [field]: value, id: { not: current.guestId } },
        select: {
          fullName: true,
          enquiries: {
            where: { deletedAt: null },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { stage: true, assignedToName: true },
          },
        },
      });
      if (other) {
        const lead = other.enquiries[0];
        const leadDetail = lead
          ? ` with a lead in ${lead.stage}${lead.assignedToName ? ` (assigned to ${lead.assignedToName})` : ""}`
          : "";
        throw new ApiError(
          "CONFLICT",
          `That ${field} already belongs to ${other.fullName}${leadDetail}. Search for it on the Leads or Guests page instead of adding it here.`,
          409,
        );
      }
    }

    let updated;
    try {
      updated = await prisma.enquiry.update({
        where: { id: params.id },
        data: {
        // F30: `?? undefined` swallowed explicit nulls, so unassigning
        // ({ assignedToSub: null }) silently left the column unchanged while an
        // "Unassigned" Activity + 200 were still written — audit log vs DB drift.
        // Only skip fields that are truly absent; preserve explicit null.
        quotedPriceINR: input.quotedPriceINR === undefined ? undefined : input.quotedPriceINR,
        assignedToSub: enteringPostBooking
          ? null
          : input.assignedToSub === undefined ? undefined : input.assignedToSub,
        assignedToName: enteringPostBooking
          ? null
          : input.assignedToName === undefined ? undefined : input.assignedToName,
        stage: (input.stage as EnquiryStage) ?? undefined,
        needsAttention: input.needsAttention ?? undefined,
        intakeNotes: input.intakeNotes !== undefined ? (input.intakeNotes || null) : undefined,
        preferredCheckIn: input.preferredCheckIn !== undefined ? input.preferredCheckIn : undefined,
        // Same explicit-null rule as the fields above (see F30): only an
        // absent key means "leave alone", so a rep can clear any of these.
        occupancy: input.occupancy === undefined ? undefined : input.occupancy,
        companionName:
          input.companionName === undefined ? undefined : input.companionName || null,
        stayDays: input.stayDays === undefined ? undefined : input.stayDays,
        roomCount: input.roomCount === undefined ? undefined : input.roomCount,
        pricePerDayINR: input.pricePerDayINR === undefined ? undefined : input.pricePerDayINR,
        roomCategory: input.roomCategory === undefined ? undefined : input.roomCategory,
        lastActivityAt: new Date(),
        // A lead can be moved OUT of Lost/Dead this way (entering it directly
        // is rejected above) — clear the auto-delete clock so a later
        // re-request/approval restarts it. See stage/route.ts's equivalent.
        ...(input.stage !== undefined && input.stage !== "lost" && current.stage === "lost"
          ? { lostAt: null }
          : {}),
        guest:
          input.fullName !== undefined ||
          input.phone !== undefined ||
          input.email !== undefined ||
          input.city !== undefined ||
          input.gender !== undefined
            ? {
                update: {
                  fullName: input.fullName ?? undefined,
                  phone: input.phone !== undefined ? (input.phone || null) : undefined,
                  email: input.email !== undefined ? (input.email || null) : undefined,
                  city: input.city !== undefined ? (input.city || null) : undefined,
                  gender: input.gender !== undefined ? (input.gender || null) : undefined,
                },
              }
            : undefined,
        },
        include: { guest: GUEST_WITH_HEALTH_COUNT },
      });
    } catch (err) {
      // Race backstop for the pre-check above — another request claimed the
      // phone/email between the check and this write.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const target = Array.isArray(err.meta?.target) ? (err.meta.target as string[]).join("/") : "contact detail";
        throw new ApiError(
          "CONFLICT",
          `That ${target} already belongs to another guest. Search for it on the Leads or Guests page instead of adding it here.`,
          409,
        );
      }
      throw err;
    }

    // Booking Confirmed / Converted is what makes a guest a returning guest.
    if (input.stage !== undefined && affectsVisited(current.stage, input.stage)) {
      await refreshGuestVisited(updated.guest.id);
    }

    if (changes.length > 0) {
      await prisma.activity.create({
        data: {
          enquiryId: updated.id,
          guestId: updated.guest.id,
          actorSub: ctx.sub,
          actorRole: ctx.roles[0] ?? "STAFF",
          actorName: ctx.name,
          actionType: "contact_update",
          metadata: { changes },
        },
      });
    }

    // A booking note of its own, so the timeline shows what the stay now is
    // rather than only what moved. `summary` is the state AFTER the save and
    // `changes` is the diff; the timeline prefers the summary and the admin
    // Activity Log filter keys off the action type.
    if (bookingChanges.length > 0) {
      await prisma.activity.create({
        data: {
          enquiryId: updated.id,
          guestId: updated.guest.id,
          actorSub: ctx.sub,
          actorRole: ctx.roles[0] ?? "STAFF",
          actorName: ctx.name,
          actionType: "booking_update",
          metadata: {
            changes: bookingChanges,
            summary: summarizeBooking({
              occupancy: updated.occupancy,
              companionName: updated.companionName,
              stayDays: updated.stayDays,
              roomCount: updated.roomCount,
              pricePerDayINR: updated.pricePerDayINR,
              roomCategory: updated.roomCategory,
            }),
          },
        },
      });
    }

    if (isReassignment) {
      await prisma.activity.create({
        data: {
          enquiryId: updated.id,
          guestId: updated.guest.id,
          actorSub: ctx.sub,
          actorRole: ctx.roles[0] ?? "STAFF",
          actorName: ctx.name,
          actionType: "assign",
          metadata: {
            from: current.assignedToName ?? "Unassigned",
            to: updated.assignedToName ?? "Unassigned",
          },
        },
      });
    } else if (enteringPostBooking && current.assignedToSub) {
      await prisma.activity.create({
        data: {
          enquiryId: updated.id,
          guestId: updated.guest.id,
          actorSub: ctx.sub,
          actorRole: ctx.roles[0] ?? "STAFF",
          actorName: ctx.name,
          actionType: "assign",
          metadata: { from: current.assignedToName ?? "Unassigned", to: "Unassigned" },
        },
      });
    }

    if (updated.assignedToSub !== current.assignedToSub) {
      await reassignTasksForEnquiry(updated.id, updated.assignedToSub);
    }

    // The same side effects a board drag has: the activity row, the RNR
    // follow-up calls, the doctor review, the payment chase. These used to be
    // missing here, so a lead moved to RNR from this form got no follow-up
    // calls at all — see lib/stage-transition.ts.
    if (input.stage !== undefined && input.stage !== current.stage) {
      await applyStageTransition({
        enquiryId: updated.id,
        guestId: updated.guest.id,
        guestName: updated.guest.fullName,
        from: current.stage,
        to: input.stage as EnquiryStage,
        assignedToSub: updated.assignedToSub,
        referralCodeId: current.referralCodeId,
        actor: { sub: ctx.sub, role: ctx.roles[0] ?? "STAFF", name: ctx.name },
      });
    }

    updated.tags = await syncEnquiryTags(updated.id);
    return ok(await withOpenTasks(await withLostRequestPending(await withRnrProgress(await withCurrentAssigneeName(toEnquiryDTO(updated))))));
  });
}

// DELETE /api/enquiries/:id?mode=soft|hard — admin-only "delete lead ticket".
//
// soft (default): sets deletedAt. The row (and its Notes/Tasks/Messages/Calls
//   history) is kept, just excluded from listEnquiries and dashboard/report
//   queries going forward. Fully reversible by clearing deletedAt.
//
// hard: wipes the guest's engagement history — Messages (WhatsApp/email),
//   Calls, Documents (+ their storage objects), the Activity audit log, and
//   AiDecisions — then removes the Enquiry row. Notes/Tasks cascade-delete
//   with it (schema-enforced). Only the Guest row itself (name/phone/email/
//   consent/etc.) survives, so re-contacting on the same number starts a
//   genuinely clean new lead instead of resurfacing old WhatsApp/call history.
//   That includes the state on the Guest row DERIVED from the history — its
//   tags (the WhatsApp line tags above all), returning-guest flag and AI
//   insight — see lib/hard-delete-guest.ts. A block survives.
//   Irreversible. NOTE: scoped to the whole guest, not just this enquiry — if
//   the guest has another still-open enquiry, its history is wiped too.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requirePermission("leads.delete");
    const mode = req.nextUrl.searchParams.get("mode") === "hard" ? "hard" : "soft";
    const current = await prisma.enquiry.findUnique({
      where: { id: params.id },
      include: { guest: { select: { fullName: true, isBlocked: true } } },
    });
    if (!current || (mode === "soft" && current.deletedAt)) {
      throw new ApiError("NOT_FOUND", "Enquiry not found", 404);
    }

    if (mode === "hard") {
      const guestId = current.guestId;
      const docs = await prisma.document.findMany({
        where: { guestId },
        select: { storageKey: true },
      });

      // Delete order respects FK restrict: AiDecision before Call (callId),
      // Message before Document (attachmentDocumentId).
      await prisma.$transaction([
        prisma.aiDecision.deleteMany({ where: { guestId } }),
        prisma.message.deleteMany({ where: { guestId } }),
        prisma.call.deleteMany({ where: { guestId } }),
        prisma.document.deleteMany({ where: { guestId } }),
        prisma.activity.deleteMany({ where: { guestId } }),
        prisma.enquiry.delete({ where: { id: params.id } }),
        prisma.guest.update({
          where: { id: guestId },
          data: guestResetAfterHardDelete({ isBlocked: current.guest.isBlocked }),
        }),
      ]);
      // "Has stayed with us" now depends only on whatever leads remain.
      await refreshGuestVisited(guestId);

      await Promise.all(
        docs.map((d) =>
          deleteObject(d.storageKey).catch((err) =>
            logger.error({ err, storageKey: d.storageKey }, "hard-delete: failed to remove storage object"),
          ),
        ),
      );

      logger.info(
        { enquiryId: params.id, guestId, guestName: current.guest.fullName, deletedBy: ctx.sub },
        "lead ticket hard-deleted — guest history wiped",
      );
    } else {
      // Freeze the correct system tags (revisit/source/age/campaign) in
      // before the card disappears from the pipeline — a lead deleted right
      // after creation, before any edit ever synced its tags, would
      // otherwise carry a stale tags column into the archive forever.
      await syncEnquiryTags(params.id);
      await prisma.enquiry.update({
        where: { id: params.id },
        data: { deletedAt: new Date() },
      });
      logger.info(
        { enquiryId: params.id, guestName: current.guest.fullName, deletedBy: ctx.sub },
        "lead ticket soft-deleted",
      );
    }

    return ok({ id: params.id, mode });
  });
}
