import { describe, expect, it } from "vitest";
import { shouldMoveToDoctorConsultation } from "./inbound-mail";

/**
 * A returning guest's medical screening form moves their existing lead to
 * Doctor Consultation — that form is the input the doctor is waiting on.
 * These are the stages where that is and isn't the right thing to do.
 */
describe("shouldMoveToDoctorConsultation", () => {
  it("moves a BRAND NEW lead — a first-time submitter is not a lesser case", () => {
    // A form from a number we have never seen creates the lead at new_lead
    // and then moves it, exactly as a returning guest's existing lead moves.
    expect(shouldMoveToDoctorConsultation("new_lead")).toBe(true);
  });

  it("moves a lead that hasn't reached the doctor yet", () => {
    for (const stage of ["new_lead", "contacted", "rnr", "qualified", "pricing_shared"]) {
      expect(shouldMoveToDoctorConsultation(stage)).toBe(true);
    }
  });

  it("moves a lead out of Lost and Staff — the form is a strong intent signal", () => {
    // A re-engaging guest parked in Lost is exactly the one nobody is looking
    // at, so leaving them there would strand the submission.
    expect(shouldMoveToDoctorConsultation("lost")).toBe(true);
    expect(shouldMoveToDoctorConsultation("staff")).toBe(true);
  });

  it("never rewinds a lead that is already at or past the doctor", () => {
    // A guest who has paid or checked in can still submit (or re-submit) the
    // form; pulling their card back would undo real progress and re-raise a
    // review the doctor has already given.
    for (const stage of ["doctor_consultation", "payment_received", "booking_confirmed", "converted"]) {
      expect(shouldMoveToDoctorConsultation(stage)).toBe(false);
    }
  });

  it("covers every stage in the pipeline", () => {
    // If a stage is added to the enum, this test is where the decision gets
    // made rather than defaulting silently to "move it".
    const allStages = [
      "new_lead", "contacted", "rnr", "qualified", "pricing_shared",
      "doctor_consultation", "payment_received", "booking_confirmed",
      "converted", "staff", "non_leads", "lost",
    ];
    const moved = allStages.filter(shouldMoveToDoctorConsultation);
    // non_leads moves for the same reason lost does: somebody filed as junk
    // who then fills in a medical screening form is plainly a real person,
    // and the doctor is who needs to see it.
    expect(moved).toEqual([
      "new_lead", "contacted", "rnr", "qualified", "pricing_shared", "staff", "non_leads", "lost",
    ]);
  });
});
