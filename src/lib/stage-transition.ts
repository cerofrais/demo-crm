/**
 * Everything that must happen when a lead changes stage, in one place.
 *
 * There are two ways to move a lead: drag it on the board, or change the stage
 * in the drawer's edit form. They went through different routes and did
 * different things — the board raised the RNR follow-up calls, opened the
 * payment chase and logged a `stage_change`; the edit form raised none of
 * them and logged the move as one line inside a `contact_update`.
 *
 * The cost was real: five leads sitting in RNR with no follow-up calls at all,
 * four of them the manager's, who reported exactly that. They were moved from
 * the drawer. Nothing was broken on screen, so nothing looked wrong — the
 * calls simply never existed.
 *
 * So both routes now call this. A stage move means the same thing however it
 * was made.
 */
import type { EnquiryStage } from "@prisma/client";
import { prisma } from "./prisma";
import {
  closePaymentPendingTasks,
  createDoctorReviewTask,
  createFollowUpTasks,
  createPaymentPendingTask,
} from "./tasks";

export interface StageTransition {
  enquiryId: string;
  guestId: string;
  guestName: string;
  from: EnquiryStage;
  to: EnquiryStage;
  /** The lead's owner AFTER the move — who the new tasks belong to. */
  assignedToSub: string | null;
  /** Set when the lead carries a referral code, to count a redemption once. */
  referralCodeId?: string | null;
  actor: { sub: string; role: string; name: string };
}

export async function applyStageTransition(t: StageTransition): Promise<void> {
  if (t.from === t.to) return;

  await prisma.activity.create({
    data: {
      enquiryId: t.enquiryId,
      guestId: t.guestId,
      actorSub: t.actor.sub,
      actorRole: t.actor.role,
      actorName: t.actor.name,
      actionType: "stage_change",
      metadata: { from: t.from, to: t.to },
    },
  });

  // Entering RNR kicks off the 6-2-1 follow-up reminders for the owner.
  if (t.to === "rnr") {
    await createFollowUpTasks(t.enquiryId, t.assignedToSub ?? t.actor.sub);
  }

  // Entering Doctor Consultation opens a review task any doctor can pick up.
  if (t.to === "doctor_consultation") {
    await createDoctorReviewTask(t.enquiryId, t.guestName, t.actor.sub);
  }

  // A lead waiting on money gets a standing chase for its owner; leaving the
  // stage resolves it, forwards to Booking Confirmed or backwards.
  if (t.to === "payment_received") {
    await createPaymentPendingTask(t.enquiryId, t.guestName, t.assignedToSub, t.actor.sub);
  }
  if (t.from === "payment_received") {
    await closePaymentPendingTasks(t.enquiryId);
  }

  // Referral redemption: counted once, when the lead is first booked (§6.5).
  if (t.to === "booking_confirmed" && t.referralCodeId) {
    await prisma.referralCode.update({
      where: { id: t.referralCodeId },
      data: { redemptionCount: { increment: 1 } },
    });
  }
}
