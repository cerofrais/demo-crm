import { describe, expect, it } from "vitest";
import { canSendEmail } from "./mailboxes";
import {
  ALL_ROLES,
  canReadAllGuestData,
  canUseWhatsAppIntegration,
  DOC_CATEGORIES,
  NAV,
  ROUTE_GUARDS,
  can,
  canAny,
  canDeleteDocuments,
  canMutateLeads,
  canReadDocCategory,
  canUploadDocCategory,
  readableDocCategories,
  canWorkLeadStage,
  isAdmin,
  mapRoles,
  navFor,
  primaryRole,
  canViewLeadStage,
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

  it("only Admin, Manager and Doctor may send from the Cloud API number", () => {
    // It is the one number that has never been banned, it carries the WABA's
    // quality rating, and every outbound-first message depends on it. The
    // Baileys numbers have been removed three times; this one must not be
    // reachable by everyone who can type a message.
    for (const r of ["ADMIN", "MANAGER", "DOCTOR"] as const) {
      expect(canUseWhatsAppIntegration([r], "cloud_api")).toBe(true);
    }
    for (const r of ["RECEPTION", "SALES", "STAFF", "VIEWER"] as const) {
      expect(canUseWhatsAppIntegration([r], "cloud_api")).toBe(false);
    }
  });

  it("leaves Baileys numbers open to anyone who can message", () => {
    // Deliberately unrestricted: losing a Baileys number is recoverable by
    // re-pairing, losing the Cloud API number is not.
    for (const r of ["RECEPTION", "SALES"] as const) {
      expect(canUseWhatsAppIntegration([r], "baileys")).toBe(true);
      expect(canUseWhatsAppIntegration([r], null)).toBe(true);
    }
  });

  it("every category an admin can upload is also one they can filter by", () => {
    // The Resources toolbar builds its FILTER from readableDocCategories and
    // its UPLOAD picker from canUploadDocCategory over the same list. When
    // those came from two hardcoded arrays they drifted: `private` was
    // filterable but not uploadable, so the category could be searched for
    // and never chosen — the file went in as whatever was selected instead.
    for (const c of DOC_CATEGORIES) {
      if (canUploadDocCategory(["ADMIN"], c)) {
        expect(readableDocCategories(["ADMIN"])).toContain(c);
      }
    }
  });

  it("an admin can upload into every category, private included", () => {
    for (const c of DOC_CATEGORIES) {
      expect(canUploadDocCategory(["ADMIN"], c)).toBe(true);
    }
  });

  it("private resources need documents.private — operational access is not enough", () => {
    // The whole point of the category: Reception and Sales work Resources
    // every day and must not see the restricted shelf inside it.
    expect(canReadDocCategory(["RECEPTION"], "private")).toBe(false);
    expect(canReadDocCategory(["SALES"], "private")).toBe(false);
    expect(canReadDocCategory(["STAFF"], "private")).toBe(false);
    expect(canReadDocCategory(["ADMIN"], "private")).toBe(true);
    expect(canReadDocCategory(["DOCTOR"], "private")).toBe(true);
    expect(canReadDocCategory(["MANAGER"], "private")).toBe(true);
  });

  it("private and medical are separate grants, not one", () => {
    // Manager is the case that proves it: they hold documents.private and
    // must still be refused medical documents. Internal rate cards and
    // guests' health records are different sensitivities, and neither grant
    // may ever imply the other.
    expect(can(["MANAGER"], "documents.private")).toBe(true);
    expect(can(["MANAGER"], "documents.medical")).toBe(false);
    expect(canReadDocCategory(["MANAGER"], "medical")).toBe(false);
    expect(canReadDocCategory(["MANAGER"], "consent")).toBe(false);
    // And the reverse: holding medical does not by itself grant private.
    expect(can(["DOCTOR"], "documents.private")).toBe(true);
  });

  it("only holders of documents.private may upload into it", () => {
    expect(canUploadDocCategory(["ADMIN"], "private")).toBe(true);
    expect(canUploadDocCategory(["DOCTOR"], "private")).toBe(true);
    expect(canUploadDocCategory(["MANAGER"], "private")).toBe(true);
    expect(canUploadDocCategory(["SALES"], "private")).toBe(false);
    expect(canUploadDocCategory(["RECEPTION"], "private")).toBe(false);
  });

  it("private never appears in a non-holder's readable categories", () => {
    // readableDocCategories drives BOTH the Resources list and
    // findAttachableDocument, so this one assertion covers listing and
    // attach-by-id together.
    expect(readableDocCategories(["SALES"])).not.toContain("private");
    expect(readableDocCategories(["RECEPTION"])).not.toContain("private");
    expect(readableDocCategories(["STAFF"])).not.toContain("private");
    // VIEWER is the exception: "read-only across the whole app" now includes
    // the internal shelf. Reading it is the entire grant — uploading into it
    // is refused for every read-only role, checked just below.
    expect(readableDocCategories(["VIEWER"])).toContain("private");
    expect(canUploadDocCategory(["VIEWER"], "private")).toBe(false);
    expect(readableDocCategories(["ADMIN"])).toContain("private");
    expect(readableDocCategories(["DOCTOR"])).toContain("private");
    expect(readableDocCategories(["MANAGER"])).toContain("private");
    // Manager gains the private shelf without gaining the medical one.
    expect(readableDocCategories(["MANAGER"])).not.toContain("medical");
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

  // Reversed deliberately: Viewer is now "read-only across the WHOLE app",
  // health records included. Safe only because reading and writing a record
  // are separate permissions — the pairing below is the guarantee, so if
  // health.edit ever leaks into this role these assertions fail.
  it("reads health records and medical documents but can never change them", () => {
    expect(can(["VIEWER"], "health.view")).toBe(true);
    expect(can(["VIEWER"], "documents.medical")).toBe(true);
    expect(canReadDocCategory(["VIEWER"], "medical")).toBe(true);
    expect(canReadDocCategory(["VIEWER"], "consent")).toBe(true);

    expect(can(["VIEWER"], "health.edit")).toBe(false);
    expect(canUploadDocCategory(["VIEWER"], "medical")).toBe(false);
    expect(canUploadDocCategory(["VIEWER"], "consent")).toBe(false);
    expect(canUploadDocCategory(["VIEWER"], "private")).toBe(false);
  });

  // The bug this role was reported for: it could open the board and the
  // Activity Log but every mailbox thread answered "you can only view
  // conversations for your own guests" — a read-only role owns no leads, and
  // the org-wide grant was spelled as the WRITE permission leads.manage.
  it("may read any guest's conversation, not just its own", () => {
    expect(canReadAllGuestData(["VIEWER"])).toBe(true);
    expect(canReadAllGuestData(["ADMIN"])).toBe(true);
    expect(canReadAllGuestData(["DOCTOR"])).toBe(true);
    // Own-only roles stay scoped to the guests they are assigned.
    expect(canReadAllGuestData(["SALES"])).toBe(false);
    expect(canReadAllGuestData(["RECEPTION"])).toBe(false);
    expect(canReadAllGuestData(["STAFF"])).toBe(false);
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

describe("Deleted Leads archive — Admin purges, Viewer only reads", () => {
  // The archive exposes a deleted lead's full message, call-recording and
  // document history, so it stays narrower than the Activity Log: only ADMIN
  // (purge) and the read-only VIEWER (read) reach it.
  const BLOCKED = ["MANAGER", "RECEPTION", "SALES", "DOCTOR"] as const;

  it("keeps the destructive permission on ADMIN alone", () => {
    expect(can(["ADMIN"], "leads.delete")).toBe(true);
    expect(can(["VIEWER"], "leads.delete")).toBe(false);
    for (const role of BLOCKED) {
      expect(can([role], "leads.delete")).toBe(false);
    }
  });

  it("shows the sidebar item to ADMIN and VIEWER only", () => {
    const item = NAV.find((n) => n.href === "/deleted");
    expect(item).toBeDefined();
    expect(navFor(["ADMIN"]).some((n) => n.href === "/deleted")).toBe(true);
    expect(navFor(["VIEWER"]).some((n) => n.href === "/deleted")).toBe(true);
    for (const role of BLOCKED) {
      expect(navFor([role]).some((n) => n.href === "/deleted")).toBe(false);
    }
  });

  it("guards the route in middleware, not just the sidebar", () => {
    // Hiding the nav link alone would leave /deleted reachable by typing it.
    const guard = ROUTE_GUARDS.find((g) => g.prefix === "/deleted");
    expect(guard).toBeDefined();
    expect(guard!.perm).toEqual(["leads.delete", "leads.viewDeleted"]);
  });
});

describe("Permissions page is admin-only", () => {
  const NON_ADMIN = ["MANAGER", "RECEPTION", "SALES", "DOCTOR", "VIEWER"] as const;

  it("is gated on users.manage, which only ADMIN holds", () => {
    expect(can(["ADMIN"], "users.manage")).toBe(true);
    for (const role of NON_ADMIN) {
      expect(can([role], "users.manage")).toBe(false);
    }
  });

  it("stays hidden from VIEWER, who does hold users.view", () => {
    // The page spells out every sensitive capability and reassigns roles, so
    // it is deliberately stricter than the Users list.
    expect(can(["VIEWER"], "users.view")).toBe(true);
    expect(navFor(["VIEWER"]).some((n) => n.href === "/permissions")).toBe(false);
    expect(navFor(["ADMIN"]).some((n) => n.href === "/permissions")).toBe(true);
  });

  it("guards the route in middleware too", () => {
    const guard = ROUTE_GUARDS.find((g) => g.prefix === "/permissions");
    expect(guard).toBeDefined();
    expect(guard!.perm).toBe("users.manage");
  });
});

describe("canSendEmail follows the permission table", () => {
  // Regression: this used to hardcode ADMIN/MANAGER/RECEPTION/DOCTOR and
  // silently drifted when SALES gained messaging.send — that role could send
  // WhatsApp (permission-guarded) but not email (list-guarded), which is how
  // a Sales rep ended up unable to email at all.
  it("matches messaging.send for every role, with no hardcoded list", () => {
    for (const role of ALL_ROLES) {
      expect(canSendEmail([role])).toBe(can([role], "messaging.send"));
    }
  });

  it("every working role can send email", () => {
    for (const role of ["ADMIN", "MANAGER", "DOCTOR", "RECEPTION", "SALES"] as const) {
      expect(canSendEmail([role])).toBe(true);
    }
  });

  it("only the view-only role cannot", () => {
    expect(canSendEmail(["STAFF"])).toBe(true);
    expect(canSendEmail(["VIEWER"])).toBe(false);
  });
});

describe("messaging.broadcast is separate from messaging.send", () => {
  // Mass-mailing the whole guest directory is a different power from replying
  // to one guest. STAFF was given the second without the first.
  it("STAFF can message a guest but not broadcast", () => {
    expect(can(["STAFF"], "messaging.send")).toBe(true);
    expect(can(["STAFF"], "messaging.broadcast")).toBe(false);
  });

  it("every other sending role keeps broadcast", () => {
    for (const role of ["ADMIN", "MANAGER", "DOCTOR", "RECEPTION", "SALES"] as const) {
      expect(can([role], "messaging.broadcast")).toBe(true);
    }
  });

  it("the view-only role has neither", () => {
    expect(can(["VIEWER"], "messaging.send")).toBe(false);
    expect(can(["VIEWER"], "messaging.broadcast")).toBe(false);
  });

  it("broadcast always implies send — no role can mass-mail without 1:1", () => {
    for (const role of ALL_ROLES) {
      if (can([role], "messaging.broadcast")) expect(can([role], "messaging.send")).toBe(true);
    }
  });
});

describe("DOCTORADMIN", () => {
  it("maps from its own Keycloak realm role", () => {
    expect(mapRoles(["crm-doctoradmin"])).toEqual(["DOCTORADMIN"]);
  });

  it("keeps every capability a Doctor has", () => {
    // The role is "Doctor, who can see the rest of the board" — losing a
    // doctor power here would be a silent downgrade for whoever holds it.
    for (const perm of [
      "health.view",
      "documents.medical",
      "documents.private",
      "leads.view",
      "guests.view",
      "leads.doctorDecision",
      "messaging.send",
      "messaging.broadcast",
      "messaging.cloudApi",
    ] as const) {
      expect(can(["DOCTORADMIN"], perm)).toBe(true);
    }
  });

  it("can SEE every column on the board", () => {
    for (const stage of [
      "new_lead", "contacted", "rnr", "qualified", "pricing_shared",
      "doctor_consultation", "payment_received", "booking_confirmed",
      "converted", "lost",
    ]) {
      expect(canViewLeadStage(["DOCTORADMIN"], stage)).toBe(true);
    }
  });

  it("can only WORK its own column", () => {
    // The whole point of the role: reading a Converted lead must not imply
    // being able to change one.
    expect(canWorkLeadStage(["DOCTORADMIN"], "doctor_consultation")).toBe(true);
    for (const stage of [
      "new_lead", "contacted", "rnr", "qualified", "pricing_shared",
      "payment_received", "booking_confirmed", "converted", "lost",
    ]) {
      expect(canWorkLeadStage(["DOCTORADMIN"], stage)).toBe(false);
    }
  });

  it("never sees the admin-only Staff lane", () => {
    expect(canViewLeadStage(["DOCTORADMIN"], "staff")).toBe(false);
    expect(canWorkLeadStage(["DOCTORADMIN"], "staff")).toBe(false);
  });

  it("does not gain pipeline or admin powers", () => {
    expect(can(["DOCTORADMIN"], "leads.manage")).toBe(false);
    expect(can(["DOCTORADMIN"], "leads.delete")).toBe(false);
    expect(can(["DOCTORADMIN"], "users.manage")).toBe(false);
  });

  it("still counts as a role that works leads", () => {
    // canMutateLeads gates the edit affordances; without this the doctor
    // decision buttons would render read-only in its own column.
    expect(canMutateLeads(["DOCTORADMIN"])).toBe(true);
  });

  it("leaves the plain Doctor role unchanged — still one column, view and work", () => {
    expect(canViewLeadStage(["DOCTOR"], "payment_received")).toBe(false);
    expect(canViewLeadStage(["DOCTOR"], "doctor_consultation")).toBe(true);
    expect(canWorkLeadStage(["DOCTOR"], "payment_received")).toBe(false);
  });

  it("does not widen view access for anyone else", () => {
    // viewAllStages is the only thing lifting the restriction, and only
    // DOCTORADMIN holds it.
    expect(canViewLeadStage(["SALES"], "booking_confirmed")).toBe(false);
    expect(canViewLeadStage(["DOCTOR"], "new_lead")).toBe(false);
    expect(canViewLeadStage(["MANAGER"], "staff")).toBe(false);
  });
});

describe("Broadcast Status is Admin/Manager only (plus read-only Viewer)", () => {
  // Front Office is the role this was reported for: it holds messaging.send
  // AND messaging.broadcast, so it cleared the sidebar, the middleware guard,
  // the page body and the API all four. Sales and the Doctor roles came in
  // the same way.
  const ALLOWED = ["ADMIN", "MANAGER", "VIEWER"] as const;
  const BLOCKED = ["RECEPTION", "SALES", "DOCTOR", "DOCTORADMIN", "STAFF"] as const;

  it("grants the permission to Admin, Manager and Viewer only", () => {
    for (const role of ALLOWED) expect(can([role], "messaging.viewStatus")).toBe(true);
    for (const role of BLOCKED) expect(can([role], "messaging.viewStatus")).toBe(false);
  });

  it("hides the sidebar item from Front Office and every other sending role", () => {
    const item = NAV.find((n) => n.href === "/broadcast-status");
    expect(item).toBeDefined();
    expect(item!.perm).toBe("messaging.viewStatus");
    for (const role of ALLOWED) {
      expect(navFor([role]).some((n) => n.href === "/broadcast-status")).toBe(true);
    }
    for (const role of BLOCKED) {
      expect(navFor([role]).some((n) => n.href === "/broadcast-status")).toBe(false);
    }
  });

  it("guards the route in middleware, not just the sidebar", () => {
    // Hiding the nav link alone would leave /broadcast-status reachable by
    // typing the URL.
    const guard = ROUTE_GUARDS.find((g) => g.prefix === "/broadcast-status");
    expect(guard).toBeDefined();
    expect(guard!.perm).toBe("messaging.viewStatus");
  });

  it("does not ride on messaging.send or messaging.broadcast", () => {
    // The two gates that used to let Front Office through. Both must stay
    // decoupled from seeing the page, or this regresses silently.
    expect(can(["RECEPTION"], "messaging.send")).toBe(true);
    expect(can(["RECEPTION"], "messaging.broadcast")).toBe(true);
    expect(can(["RECEPTION"], "messaging.viewStatus")).toBe(false);
  });

  it("leaves Front Office able to SEND a broadcast — only the status page moved", () => {
    // Scope check: the report was about visibility of the status tab, not
    // about taking mass-send away from the front desk.
    for (const role of ["RECEPTION", "SALES", "DOCTOR", "DOCTORADMIN"] as const) {
      expect(can([role], "messaging.broadcast")).toBe(true);
    }
  });
});
