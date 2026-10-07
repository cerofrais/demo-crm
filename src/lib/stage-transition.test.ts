import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyStageTransition } from "./stage-transition";

const activityCreate = vi.fn();
const referralUpdate = vi.fn();
const createFollowUpTasks = vi.fn();
const createDoctorReviewTask = vi.fn();
const createPaymentPendingTask = vi.fn();
const closePaymentPendingTasks = vi.fn();

vi.mock("./prisma", () => ({
  prisma: {
    activity: { create: (...a: unknown[]) => activityCreate(...a) },
    referralCode: { update: (...a: unknown[]) => referralUpdate(...a) },
  },
}));
vi.mock("./tasks", () => ({
  createFollowUpTasks: (...a: unknown[]) => createFollowUpTasks(...a),
  createDoctorReviewTask: (...a: unknown[]) => createDoctorReviewTask(...a),
  createPaymentPendingTask: (...a: unknown[]) => createPaymentPendingTask(...a),
  closePaymentPendingTasks: (...a: unknown[]) => closePaymentPendingTasks(...a),
}));

const base = {
  enquiryId: "e1",
  guestId: "g1",
  guestName: "Nandita Madhav",
  assignedToSub: "owner-sub",
  actor: { sub: "actor-sub", role: "MANAGER", name: "Kruthika P" },
};

beforeEach(() => {
  activityCreate.mockReset();
  referralUpdate.mockReset();
  createFollowUpTasks.mockReset();
  createDoctorReviewTask.mockReset();
  createPaymentPendingTask.mockReset();
  closePaymentPendingTasks.mockReset();
});

describe("applyStageTransition", () => {
  it("records the move as a stage_change, whichever screen it came from", async () => {
    await applyStageTransition({ ...base, from: "new_lead", to: "rnr" });
    expect(activityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actionType: "stage_change", metadata: { from: "new_lead", to: "rnr" } }),
      }),
    );
  });

  it("raises the RNR follow-up calls for the lead's owner", async () => {
    // The bug this file exists for: moved from the drawer, these were never
    // created, so four of the manager's RNR leads had no follow-ups at all.
    await applyStageTransition({ ...base, from: "new_lead", to: "rnr" });
    expect(createFollowUpTasks).toHaveBeenCalledWith("e1", "owner-sub");
  });

  it("falls back to whoever moved it when the lead has no owner", async () => {
    await applyStageTransition({ ...base, assignedToSub: null, from: "contacted", to: "rnr" });
    expect(createFollowUpTasks).toHaveBeenCalledWith("e1", "actor-sub");
  });

  it("opens a doctor review on the way into consultation", async () => {
    await applyStageTransition({ ...base, from: "qualified", to: "doctor_consultation" });
    expect(createDoctorReviewTask).toHaveBeenCalledWith("e1", "Nandita Madhav", "actor-sub");
  });

  it("opens the payment chase on the way in and closes it on the way out", async () => {
    await applyStageTransition({ ...base, from: "qualified", to: "payment_received" });
    expect(createPaymentPendingTask).toHaveBeenCalledWith("e1", "Nandita Madhav", "owner-sub", "actor-sub");
    expect(closePaymentPendingTasks).not.toHaveBeenCalled();

    await applyStageTransition({ ...base, from: "payment_received", to: "booking_confirmed" });
    expect(closePaymentPendingTasks).toHaveBeenCalledWith("e1");
  });

  it("counts a referral redemption once, when the lead is first booked", async () => {
    await applyStageTransition({ ...base, from: "payment_received", to: "booking_confirmed", referralCodeId: "r1" });
    expect(referralUpdate).toHaveBeenCalledWith({ where: { id: "r1" }, data: { redemptionCount: { increment: 1 } } });

    referralUpdate.mockReset();
    await applyStageTransition({ ...base, from: "payment_received", to: "booking_confirmed" });
    expect(referralUpdate).not.toHaveBeenCalled();
  });

  it("does nothing at all when the stage has not actually changed", async () => {
    await applyStageTransition({ ...base, from: "rnr", to: "rnr" });
    expect(activityCreate).not.toHaveBeenCalled();
    expect(createFollowUpTasks).not.toHaveBeenCalled();
  });
});
