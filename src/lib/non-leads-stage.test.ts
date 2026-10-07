import { describe, it, expect } from "vitest";
import { STAGES, STAGE_MAP, STAGE_IDS } from "./kanban";
import { canViewLeadStage, canWorkLeadStage } from "./rbac";

/**
 * "Non-Leads" is for submissions that were never a lead — spam, vendors,
 * wrong numbers. It is deliberately NOT Lost/Dead, which is a real enquiry
 * that did not convert; mixing the two makes every conversion figure read
 * worse than reality.
 */
describe("Non-Leads column", () => {
  it("sits between Staff and Lost/Dead", () => {
    const ids = STAGES.map((s) => s.id);
    expect(ids.indexOf("non_leads")).toBe(ids.indexOf("staff") + 1);
    expect(ids.indexOf("lost")).toBe(ids.indexOf("non_leads") + 1);
  });

  it("is a real column with its own label", () => {
    expect(STAGE_MAP.non_leads.label).toBe("Non-Leads");
    expect(STAGE_IDS).toContain("non_leads");
  });

  it("is visible and workable by every lead-working role", () => {
    // Unlike Staff, which is Admin-only: filing junk is ordinary triage, not
    // a privileged action.
    for (const role of ["ADMIN", "MANAGER", "SALES", "RECEPTION"] as const) {
      expect(canViewLeadStage([role], "non_leads"), role).toBe(true);
      expect(canWorkLeadStage([role], "non_leads"), role).toBe(true);
    }
  });

  it("stays out of the Doctor's consultation-only view", () => {
    expect(canWorkLeadStage(["DOCTOR"], "non_leads")).toBe(false);
  });
});
