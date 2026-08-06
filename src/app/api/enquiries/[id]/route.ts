import { NextRequest } from "next/server";
import { handle, ok, requireSession, requirePermission, ApiError } from "@/lib/api";
import { can, canMutateLeads, canWorkLeadStage, isPostBookingStage, isAdmin } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toEnquiryDTO, withCurrentAssigneeName } from "@/lib/enquiries";
import { updateEnquirySchema } from "@/lib/validation";
import { syncEnquiryTags } from "@/lib/tags-service";
import { createDoctorReviewTask, reassignTasksForEnquiry, withRnrProgress, withLostRequestPending } from "@/lib/tasks";
import { logger } from "@/lib/logger";
import { deleteObject } from "@/lib/storage";
import type { EnquiryStage } from "@prisma/client";

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
      include: { guest: true },
    });
    if (!enquiry) throw new ApiError("NOT_FOUND", "Enquiry not found", 404);

    if (!can(ctx.roles, "leads.manage") && can(ctx.roles, "leads.ownOnly")) {
      const ownedOrUnassigned =
        enquiry.assignedToSub === ctx.sub || enquiry.assignedToSub === null;
      if (!ownedOrUnassigned) throw new ApiError("FORBIDDEN", "Cannot view this lead", 403);
    }
    if (!canWorkLeadStage(ctx.roles, enquiry.stage)) {
      throw new ApiError("FORBIDDEN", "Cannot view this lead", 403);
    }

    return ok(await withLostRequestPending(await withRnrProgress(await withCurrentAssigneeName(toEnquiryDTO(enquiry)))));
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

    const changes: string[] = [];
    if (input.stage !== undefined && input.stage !== current.stage) {
      changes.push(`Stage: ${current.stage} -> ${input.stage}`);
    }
    if (input.quotedPriceINR !== undefined && input.quotedPriceINR !== current.quotedPriceINR) {
      changes.push(
        `Quoted price: ${current.quotedPriceINR ?? "-"} -> ${input.quotedPriceINR ?? "-"}`,
      );
    }
    if (input.intakeNotes !== undefined && input.intakeNotes !== current.intakeNotes) {
      changes.push("Notes updated");
    }
    const isReassignment =
      !enteringPostBooking &&
      input.assignedToSub !== undefined && input.assignedToSub !== current.assignedToSub;
    if (isReassignment) {
      const allowedToReassign = can(ctx.roles, "leads.manage");
      if (!allowedToReassign) throw new ApiError("FORBIDDEN", "Cannot reassign this lead", 403);
    }

    const currentGuest = await prisma.guest.findUnique({
      where: { id: current.guestId },
      select: { fullName: true, phone: true, email: true, city: true },
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

    const updated = await prisma.enquiry.update({
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
          input.city !== undefined
            ? {
                update: {
                  fullName: input.fullName ?? undefined,
                  phone: input.phone !== undefined ? (input.phone || null) : undefined,
                  email: input.email !== undefined ? (input.email || null) : undefined,
                  city: input.city !== undefined ? (input.city || null) : undefined,
                },
              }
            : undefined,
      },
      include: { guest: true },
    });

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

    if (input.stage === "doctor_consultation" && current.stage !== "doctor_consultation") {
      await createDoctorReviewTask(updated.id, updated.guest.fullName, ctx.sub);
    }

    updated.tags = await syncEnquiryTags(updated.id);
    return ok(await withLostRequestPending(await withRnrProgress(await withCurrentAssigneeName(toEnquiryDTO(updated)))));
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
      include: { guest: { select: { fullName: true } } },
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
      ]);

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
