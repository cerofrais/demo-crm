import { describe, expect, it } from "vitest";
import {
  can,
  canAny,
  canDeleteDocuments,
  canMutateLeads,
  canReadDocCategory,
  canUploadDocCategory,
  canWorkLeadStage,
  isAdmin,
  mapRoles,
  primaryRole,
} from "./rbac";

describe("mapRoles", () => {
  it("maps known Keycloak realm roles to app roles", () => {
    expect(mapRoles(["crm-admin"])).toEqual(["ADMIN"]);
    expect(mapRoles(["crm-reception", "crm-staff"])).toEqual(["RECEPTION", "STAFF"]);
  });

  it("drops unknown roles instead of throwing", () => {
    expect(mapRoles(["crm-admin", "some-unrelated-realm-role"])).toEqual(["ADMIN"]);
  });

  it("de-duplicates when multiple realm roles map to the same app role", () => {
    expect(mapRoles(["crm-admin", "crm-admin"])).toEqual(["ADMIN"]);
  });

  it("returns an empty array for undefined or empty input", () => {
    expect(mapRoles(undefined)).toEqual([]);
    expect(mapRoles([])).toEqual([]);
  });
});

describe("can", () => {
  it("grants leads.delete only to ADMIN", () => {
    expect(can(["ADMIN"], "leads.delete")).toBe(true);
    expect(can(["MANAGER"], "leads.delete")).toBe(false);
    expect(can(["STAFF"], "leads.delete")).toBe(false);
  });

  it("returns true if ANY of the user's roles grants the permission", () => {
    expect(can(["STAFF", "ADMIN"], "leads.delete")).toBe(true);
  });

  it("returns false for a user with no roles", () => {
    expect(can([], "leads.view")).toBe(false);
  });
});

describe("isAdmin / primaryRole", () => {
  it("isAdmin is true only when ADMIN is present", () => {
    expect(isAdmin(["ADMIN", "STAFF"])).toBe(true);
    expect(isAdmin(["STAFF"])).toBe(false);
    expect(isAdmin([])).toBe(false);
  });

  it("primaryRole picks the highest-privilege role present", () => {
    expect(primaryRole(["STAFF", "MANAGER"])).toBe("MANAGER");
    expect(primaryRole(["STAFF"])).toBe("STAFF");
    expect(primaryRole([])).toBeUndefined();
  });
});

describe("document category access (F24/DPDP-sensitive)", () => {
  it("medical and consent categories require documents.medical, not documents.operational", () => {
    expect(canReadDocCategory(["DOCTOR"], "medical")).toBe(true);
    expect(canReadDocCategory(["RECEPTION"], "medical")).toBe(false);
    expect(canReadDocCategory(["RECEPTION"], "operational")).toBe(true);
  });

  it("plain STAFF cannot upload operational documents (read-only)", () => {
    expect(canUploadDocCategory(["STAFF"], "operational")).toBe(false);
  });

  it("marketing uploads are restricted to ADMIN/MANAGER regardless of documents.medical", () => {
    expect(canUploadDocCategory(["ADMIN"], "marketing")).toBe(true);
    expect(canUploadDocCategory(["MANAGER"], "marketing")).toBe(true);
    expect(canUploadDocCategory(["DOCTOR"], "marketing")).toBe(false);
  });

  it("only ADMIN can hard-delete documents", () => {
    expect(canDeleteDocuments(["ADMIN"])).toBe(true);
    expect(canDeleteDocuments(["MANAGER"])).toBe(false);
  });
});

describe("SALES role (crm-sales)", () => {
  it("maps crm-sales to SALES", () => {
    expect(mapRoles(["crm-sales"])).toEqual(["SALES"]);
  });

  it("has the same base permissions as RECEPTION", () => {
    for (const perm of ["leads.view", "leads.ownOnly", "messaging.send", "documents.operational", "reports.own"] as const) {
      expect(can(["SALES"], perm)).toBe(can(["RECEPTION"], perm));
    }
  });

  it("cannot manage all leads, delete tickets, or see dashboard/reports.allStaff — same ceiling as RECEPTION", () => {
    for (const perm of ["leads.manage", "leads.delete", "dashboard.view", "reports.allStaff"] as const) {
      expect(can(["SALES"], perm)).toBe(false);
    }
  });

  it("uniquely holds leads.preBookingOnly (RECEPTION does not)", () => {
    expect(can(["SALES"], "leads.preBookingOnly")).toBe(true);
    expect(can(["RECEPTION"], "leads.preBookingOnly")).toBe(false);
  });

  it("cannot see the Guests directory, unlike RECEPTION — nav stays to Leads/Tasks/Reports", () => {
    expect(can(["SALES"], "guests.view")).toBe(false);
    expect(can(["RECEPTION"], "guests.view")).toBe(true);
  });
});

describe("canWorkLeadStage", () => {
  it("SALES loses access once a lead is booking_confirmed or converted", () => {
    expect(canWorkLeadStage(["SALES"], "booking_confirmed")).toBe(false);
    expect(canWorkLeadStage(["SALES"], "converted")).toBe(false);
  });

  it("SALES retains access to every pre-booking stage except the Admin-only Staff column", () => {
    for (const stage of ["new_lead", "contacted", "rnr", "qualified", "pricing_shared", "doctor_consultation", "payment_received", "lost"]) {
      expect(canWorkLeadStage(["SALES"], stage)).toBe(true);
    }
  });

  it("RECEPTION and roles without leads.preBookingOnly are unaffected by stage", () => {
    expect(canWorkLeadStage(["RECEPTION"], "booking_confirmed")).toBe(true);
    expect(canWorkLeadStage(["RECEPTION"], "converted")).toBe(true);
    expect(canWorkLeadStage(["ADMIN"], "converted")).toBe(true);
  });

  it("DOCTOR is unaffected by the new payment_received stage — still consultation-only", () => {
    expect(canWorkLeadStage(["DOCTOR"], "payment_received")).toBe(false);
    expect(canWorkLeadStage(["DOCTOR"], "doctor_consultation")).toBe(true);
  });

  it("Staff column is Admin-only — every other role, including Manager, loses access", () => {
    expect(canWorkLeadStage(["ADMIN"], "staff")).toBe(true);
    expect(canWorkLeadStage(["MANAGER"], "staff")).toBe(false);
    expect(canWorkLeadStage(["SALES"], "staff")).toBe(false);
    expect(canWorkLeadStage(["RECEPTION"], "staff")).toBe(false);
    expect(canWorkLeadStage(["DOCTOR"], "staff")).toBe(false);
  });
});

describe("leads.doctorDecision", () => {
  it("is granted only to DOCTOR", () => {
    expect(can(["DOCTOR"], "leads.doctorDecision")).toBe(true);
    expect(can(["ADMIN"], "leads.doctorDecision")).toBe(false);
    expect(can(["MANAGER"], "leads.doctorDecision")).toBe(false);
    expect(can(["RECEPTION"], "leads.doctorDecision")).toBe(false);
  });
});

describe("VIEWER role (crm-viewer) — read-only across the app", () => {
  it("maps crm-viewer to VIEWER", () => {
    expect(mapRoles(["crm-viewer"])).toEqual(["VIEWER"]);
  });

  it("holds every *.view permission but no manage/delete/send permission", () => {
    const viewPerms = [
      "dashboard.view", "leads.view", "guests.view", "reports.allStaff", "reports.own",
      "ai.audit", "users.view", "packages.view", "referrals.view", "whatsapp.view",
      "lead-assignment.view", "templates.view",
    ] as const;
    for (const p of viewPerms) expect(can(["VIEWER"], p)).toBe(true);

    const writePerms = [
      "leads.manage", "leads.ownOnly", "leads.preBookingOnly", "leads.consultationOnly",
      "leads.doctorDecision", "leads.delete", "guests.delete", "messaging.send",
      "packages.manage", "referrals.manage", "users.manage", "whatsapp.manage",
    ] as const;
    for (const p of writePerms) expect(can(["VIEWER"], p)).toBe(false);
  });

  it("cannot see Health Records or medical documents", () => {
    expect(can(["VIEWER"], "health.view")).toBe(false);
    expect(can(["VIEWER"], "documents.medical")).toBe(false);
    expect(canReadDocCategory(["VIEWER"], "medical")).toBe(false);
    expect(canReadDocCategory(["VIEWER"], "consent")).toBe(false);
  });

  it("can read operational documents but not upload them, same as STAFF", () => {
    expect(canReadDocCategory(["VIEWER"], "operational")).toBe(true);
    expect(canUploadDocCategory(["VIEWER"], "operational")).toBe(false);
  });
});

describe("canAny", () => {
  it("is true if any listed permission is held", () => {
    expect(canAny(["VIEWER"], ["packages.manage", "packages.view"])).toBe(true);
    expect(canAny(["SALES"], ["packages.manage", "packages.view"])).toBe(false);
  });
});

describe("canMutateLeads", () => {
  it("is true for roles that actually work leads (manage/ownOnly/consultationOnly)", () => {
    expect(canMutateLeads(["ADMIN"])).toBe(true);
    expect(canMutateLeads(["MANAGER"])).toBe(true);
    expect(canMutateLeads(["RECEPTION"])).toBe(true);
    expect(canMutateLeads(["SALES"])).toBe(true);
    expect(canMutateLeads(["DOCTOR"])).toBe(true);
  });

  it("is false for read-only roles — bare leads.view isn't enough", () => {
    expect(canMutateLeads(["STAFF"])).toBe(false);
    expect(canMutateLeads(["VIEWER"])).toBe(false);
    expect(canMutateLeads([])).toBe(false);
  });
});
