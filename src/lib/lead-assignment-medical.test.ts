import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const findMany = vi.fn();

vi.mock("./prisma", () => ({
  prisma: {
    leadAssignmentSettings: { findUnique: (...a: unknown[]) => findUnique(...a) },
    staffProfile: { findMany: (...a: unknown[]) => findMany(...a) },
    leadRoutingState: {
      upsert: async () => ({ id: "medical_form", lastAssignedSub: null }),
      update: async () => ({}),
    },
    enquiry: { groupBy: vi.fn() },
  },
}));
vi.mock("./staff-availability", () => ({ availableSubsToday: async (subs: string[]) => subs }));
vi.mock("./lead-routing", () => ({ assignNextRep: async () => ({ sub: "fallback", name: "Fallback Rep" }) }));

const { routeMedicalForm, LEAD_ASSIGNMENT_CATEGORIES, SOURCE_ROUTED_CATEGORIES, MEDICAL_FORM_CATEGORY } = await import(
  "./lead-assignment"
);

beforeEach(() => {
  findUnique.mockReset();
  findMany.mockReset();
});

describe("the pre-arrival form rule", () => {
  it("is offered on the Lead Assignment page", () => {
    expect(LEAD_ASSIGNMENT_CATEGORIES).toContain(MEDICAL_FORM_CATEGORY);
  });

  it("is not a lead source, so it never routes an ordinary enquiry", () => {
    // Routing keys off Enquiry.source; "medical_form" is a kind of form, not
    // a source, and letting it into this list would make it compete with the
    // channel rules for every lead.
    expect(SOURCE_ROUTED_CATEGORIES).not.toContain(MEDICAL_FORM_CATEGORY);
  });

  it("changes nothing while nobody is configured", async () => {
    // The whole point: until an admin fills the pool, pre-arrival forms keep
    // behaving exactly as they do today — no assignee, no handover.
    findUnique.mockResolvedValue(null);
    expect(await routeMedicalForm()).toEqual({ assignee: null, reassignExisting: false });

    findUnique.mockResolvedValue({ category: "medical_form", strategy: "round_robin", eligibleSubs: [], reassignExisting: true });
    expect(await routeMedicalForm()).toEqual({ assignee: null, reassignExisting: false });
  });

  it("names the configured person, and says whether owned leads hand over", async () => {
    findUnique.mockResolvedValue({
      category: "medical_form",
      strategy: "round_robin",
      eligibleSubs: ["front-office-sub"],
      reassignExisting: true,
    });
    findMany.mockResolvedValue([{ keycloakId: "front-office-sub", displayName: "Prashanth B" }]);

    const routing = await routeMedicalForm();
    expect(routing.assignee).toEqual({ sub: "front-office-sub", name: "Prashanth B" });
    expect(routing.reassignExisting).toBe(true);
  });
});
