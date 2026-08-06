import { describe, expect, it } from "vitest";
import { backfillHealthRecord } from "./health-ingest";
import { emptyHealthRecord } from "./health";

describe("backfillHealthRecord", () => {
  it("fills every still-default field on an empty record", () => {
    const { merged, changed } = backfillHealthRecord(emptyHealthRecord(), {
      bloodGroup: "B+",
      allergies: ["None"],
      recentSurgeries: { flag: false, detail: "" },
      seizures: { flag: true, detail: "one episode in 2020" },
    });
    expect(changed).toBe(true);
    expect(merged.bloodGroup).toBe("B+");
    expect(merged.allergies).toEqual(["None"]);
    expect(merged.seizures).toEqual({ flag: true, detail: "one episode in 2020" });
  });

  it("never overwrites a field a doctor already set, even with a non-empty incoming value", () => {
    const existing = { ...emptyHealthRecord(), bloodGroup: "O+", doctorNotes: "Cleared for full program" };
    const { merged, changed } = backfillHealthRecord(existing, {
      bloodGroup: "B+", // conflicting — should be ignored
      occupation: "Business", // still blank on existing — should apply
    });
    expect(merged.bloodGroup).toBe("O+"); // untouched
    expect(merged.occupation).toBe("Business"); // backfilled
    expect(changed).toBe(true);
  });

  it("treats a yesNoDetail field with a non-default flag as already touched, and doesn't overwrite it", () => {
    const existing = { ...emptyHealthRecord(), heartDisease: { flag: true, detail: "angioplasty 2018" } };
    const { merged } = backfillHealthRecord(existing, {
      heartDisease: { flag: false, detail: "" },
    });
    expect(merged.heartDisease).toEqual({ flag: true, detail: "angioplasty 2018" });
  });

  it("reports changed=false when the incoming submission adds nothing new", () => {
    const existing = { ...emptyHealthRecord(), bloodGroup: "O+" };
    const { changed } = backfillHealthRecord(existing, { bloodGroup: "B+" });
    expect(changed).toBe(false);
  });

  it("reports changed=false for a guest re-submitting the same (still-empty) form twice", () => {
    const { changed } = backfillHealthRecord(emptyHealthRecord(), {});
    expect(changed).toBe(false);
  });
});
