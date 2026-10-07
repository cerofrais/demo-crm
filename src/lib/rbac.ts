/**
 * Role-Based Access Control — single source of truth for the spec's §8 matrix.
 * Keycloak realm roles map to CRM app roles; permissions are derived from role.
 * Used in middleware (route gating), API handlers, and to filter the sidebar.
 */

export type AppRole =
  | "ADMIN"
  | "DOCTOR"
  | "DOCTORADMIN"
  | "MANAGER"
  | "RECEPTION"
  | "SALES"
  | "STAFF"
  | "VIEWER";

export const KEYCLOAK_ROLE_MAP: Record<string, AppRole> = {
  "crm-admin": "ADMIN",
  "crm-doctor": "DOCTOR",
  "crm-doctoradmin": "DOCTORADMIN",
  "crm-manager": "MANAGER",
  "crm-reception": "RECEPTION",
  "crm-sales": "SALES",
  "crm-staff": "STAFF",
  "crm-viewer": "VIEWER",
};

/** Map raw Keycloak realm roles -> CRM app roles. */
export function mapRoles(realmRoles: string[] | undefined): AppRole[] {
  if (!realmRoles) return [];
  const mapped = realmRoles
    .map((r) => KEYCLOAK_ROLE_MAP[r])
    .filter((r): r is AppRole => Boolean(r));
  return Array.from(new Set(mapped));
}

/** A discrete capability that a feature/route requires. */
export type Permission =
  | "dashboard.view" // org-wide analytics
  | "leads.view"
  | "guests.view" // the Guests directory — everyone except Sales
  | "leads.manage" // create/move/assign across pipeline
  | "leads.ownOnly" // restricted to own assigned leads
  | "leads.preBookingOnly" // loses access once a lead reaches booking_confirmed/converted
  | "leads.consultationOnly" // sees only leads currently in doctor_consultation, org-wide
  | "leads.viewAllStages" // Doctor Admin: sees every column, but still only WORKS its own
  | "leads.doctorDecision" // record Accept/Reject/Needs-phone-consult on a consultation-stage lead — doctor only
  | "leads.delete" // delete a lead ticket — admin only
  | "leads.viewDeleted" // read the deleted-lead archive without being able to purge it
  | "leads.viewStaffLane" // see the admin-only Staff parking column
  | "guests.delete" // delete a guest record — admin only
  | "health.view" // READ a health record
  | "health.edit" // create/replace/delete one — split from health.view so a
  // read-only role can be given sight of records without gaining the power to
  // overwrite them; the route used to gate GET, PUT and DELETE on the same
  // permission, so granting "view" silently granted "destroy".
  | "messaging.send"
  | "messaging.broadcast" // mass-send: broadcasts + bulk email to the guest directory
  | "messaging.viewStatus" // watch broadcast progress without being able to start one
  | "documents.medical"
  | "documents.private"
  | "messaging.cloudApi"
  | "documents.operational"
  | "packages.manage"
  | "packages.view" // see packages without create/edit/deactivate — implied by packages.manage too
  | "referrals.manage"
  | "referrals.view" // see referral codes without creating new ones
  // Listening to a call recording. Split out from reports.allStaff because
  // those are different questions: the Calls screen is a report, while the
  // recording is the guest's own voice and a rep's unscripted sales pitch.
  // Separating them is what lets the matrix show, per role, who can actually
  // hear a call — and lets that be withdrawn without closing the screen.
  | "calls.recording"
  | "reports.allStaff"
  | "reports.own"
  | "users.manage"
  | "users.view" // see the Users list without create/edit/delete/reset-password/routing config
  | "ai.audit" // view the AI/ML decision log (prompts + outputs) — admin only
  // Ask the database in plain English. ADMIN alone, and deliberately not
  // bundled into reports.allStaff or ai.audit (both of which VIEWER and
  // MANAGER hold): the query is written by a model against a table
  // allowlist, so it can return any shape of data from those tables at once
  // — every guest's phone number, every lost reason, every rep's numbers —
  // which no report screen exposes in one place.
  | "db.query"
  | "whatsapp.manage" // onboard/manage WhatsApp numbers — admin only
  | "whatsapp.view" // see connected numbers without onboarding/reconnecting/deleting
  | "lead-assignment.view" // see routing config without changing it
  | "templates.view"; // see message templates without creating/editing/deleting

const PERMISSIONS: Record<AppRole, Permission[]> = {
  ADMIN: [
    "dashboard.view",
    "leads.view",
    "guests.view",
    "leads.manage",
    "health.view",
    "messaging.send",
    "messaging.broadcast",
    "messaging.cloudApi",
    "documents.medical",
    "documents.private",
    "documents.operational",
    "packages.manage",
    "referrals.manage",
    "reports.allStaff",
    "calls.recording",
    "reports.own",
    "users.manage",
    "ai.audit",
    "db.query",
    "whatsapp.manage",
    "leads.delete",
    "leads.viewDeleted",
    "leads.viewStaffLane",
    "guests.delete",
    "health.edit",
    "leads.viewAllStages",
    "messaging.viewStatus",
  ],
  MANAGER: [
    "dashboard.view",
    "leads.view",
    "guests.view",
    "leads.manage",
    "messaging.send",
    "messaging.broadcast",
    "messaging.cloudApi",
    "documents.operational",
    // Restricted Resources files only — deliberately NOT documents.medical,
    // so a Manager gains the internal shelf without gaining guests' health
    // records. Keeping those two grants separate is the reason `private` is
    // its own permission rather than a use of the medical one.
    "documents.private",
    "packages.manage",
    "referrals.manage",
    "reports.allStaff",
    "calls.recording",
    "reports.own",
    "messaging.viewStatus",
  ],
  // Sees the Leads page, but restricted to only the Doctor Consultation
  // column, org-wide (not scoped to any single doctor's own leads — there's
  // no per-doctor assignment concept on Enquiry).
  DOCTOR: [
    "health.view",
    "health.edit",
    "documents.medical",
    "documents.private",
    "leads.view",
    "guests.view",
    "leads.consultationOnly",
    "leads.doctorDecision",
    // Same email/WhatsApp/call capability Manager has — canSendEmail()
    // already granted Doctor unrestricted email; this brings WhatsApp,
    // click-to-call, message edit/delete, and the template picker in line
    // with that same precedent instead of leaving them WhatsApp-only gaps.
    "messaging.send",
    "messaging.broadcast",
    "messaging.cloudApi",
  ],
  // A Doctor who can see the whole board. Identical powers to DOCTOR —
  // including the fact that Doctor Consultation is the only column it can
  // change anything in — with read access to every other stage on top, so it
  // can follow what became of the leads it reviewed.
  //
  // Deliberately NOT given leads.manage: outside its own column this role
  // looks, it does not work the pipeline. Reading a Converted lead must never
  // imply being able to edit one, which is why canViewLeadStage and
  // canWorkLeadStage are separate functions.
  DOCTORADMIN: [
    "health.view",
    "health.edit",
    "documents.medical",
    "documents.private",
    "leads.view",
    "guests.view",
    // Keeps consultationOnly — what it can CHANGE is still just its own
    // column — and adds viewAllStages on top, which lifts the same
    // restriction for reading only. The two together are the whole role.
    "leads.consultationOnly",
    "leads.viewAllStages",
    "leads.doctorDecision",
    "messaging.send",
    "messaging.broadcast",
    "messaging.cloudApi",
  ],
  RECEPTION: [
    "leads.view",
    "guests.view",
    "leads.ownOnly",
    "messaging.send",
    "messaging.broadcast",
    "documents.operational",
    "reports.own",
  ],
  // Same as RECEPTION, plus a stage boundary: once a lead reaches Booking
  // Confirmed it's auto-unassigned (see the stage-transition routes) and
  // "leads.preBookingOnly" excludes it from this role's view/actions from
  // then on — sales works the pipeline up to the close, reception takes it
  // from there.
  //
  // No "guests.view": Sales works leads, not the guest directory — keeps
  // their nav to Leads / Tasks / Reports (+ Resources, Settings).
  SALES: [
    "leads.view",
    "leads.ownOnly",
    "leads.preBookingOnly",
    "messaging.send",
    "messaging.broadcast",
    "documents.operational",
    "reports.own",
  ],
  // Read-only on the pipeline (no leads.manage/ownOnly, so canMutateLeads is
  // false), but it can reach out to an individual guest — email, WhatsApp,
  // click-to-call. Deliberately WITHOUT messaging.broadcast: replying to one
  // guest and mass-mailing the entire directory are very different powers,
  // and only the first was asked for.
  STAFF: ["leads.view", "guests.view", "documents.operational", "messaging.send"],
  // Read-only across the WHOLE app — every read permission that exists, and
  // none that writes: no ".manage"/"ownOnly"/"delete"/"send"/".edit".
  //
  // health.view and documents.medical are included, which is a reversal of
  // the original decision to keep guests' medical records out of this role.
  // It is safe only because reading and writing a health record are now
  // separate permissions: this role can open a record but health.edit is what
  // saves or deletes one, and it does not hold that. If the medical grant is
  // ever withdrawn, drop those two lines — nothing else here depends on them.
  VIEWER: [
    "dashboard.view",
    "leads.view",
    "leads.viewAllStages",
    "leads.viewDeleted",
    "leads.viewStaffLane",
    "guests.view",
    "health.view",
    "documents.medical",
    "documents.private",
    "documents.operational",
    "messaging.viewStatus",
    "reports.allStaff",
    "calls.recording",
    "reports.own",
    "ai.audit",
    "users.view",
    "packages.view",
    "referrals.view",
    "whatsapp.view",
    "lead-assignment.view",
    "templates.view",
  ],
};

/**
 * The permissions a single role grants, for display. `can()` remains the only
 * thing that should ever be used to make an access decision — this is a copy
 * so a caller can't mutate the table that authorization reads from.
 */
export function permissionsFor(role: AppRole): Permission[] {
  return [...(PERMISSIONS[role] ?? [])];
}

/** Every role in the system, in the order the permissions matrix shows them. */
export const ALL_ROLES: AppRole[] = [
  "ADMIN",
  "MANAGER",
  "DOCTOR",
  "DOCTORADMIN",
  "RECEPTION",
  "SALES",
  "STAFF",
  "VIEWER",
];

export function can(roles: AppRole[], perm: Permission): boolean {
  return roles.some((r) => PERMISSIONS[r]?.includes(perm));
}

/** True if the role set holds ANY of the listed permissions. */
export function canAny(roles: AppRole[], perms: Permission[]): boolean {
  return perms.some((p) => can(roles, p));
}

/**
 * True if `roles` can actually mutate a lead (edit fields, add a note/task,
 * change stage via drag, place a WhatsApp call) — the three permissions that
 * represent "this role works leads" in some capacity. Bare `leads.view` is
 * NOT enough; VIEWER and any future read-only role hold only that and stay
 * blocked. Used both server-side (route guards) and client-side (hiding the
 * edit affordances instead of just failing the request on submit).
 */
export function canMutateLeads(roles: AppRole[]): boolean {
  return canAny(roles, ["leads.manage", "leads.ownOnly", "leads.consultationOnly"]);
}

export function isAdmin(roles: AppRole[]): boolean {
  return roles.includes("ADMIN");
}

/** Highest-privilege role for display purposes. */
export function primaryRole(roles: AppRole[]): AppRole | undefined {
  const order: AppRole[] = [
    "ADMIN",
    "MANAGER",
    "DOCTORADMIN",
    "DOCTOR",
    "RECEPTION",
    "SALES",
    "STAFF",
    "VIEWER",
  ];
  return order.find((r) => roles.includes(r));
}

export const ROLE_LABEL: Record<AppRole, string> = {
  ADMIN: "Administrator",
  DOCTOR: "Doctor",
  DOCTORADMIN: "Doctor Admin",
  MANAGER: "Manager",
  RECEPTION: "Front Office",
  SALES: "Sales",
  STAFF: "Staff",
  VIEWER: "Viewer (Read-Only)",
};

/** Stages a "leads.preBookingOnly" role (Sales) loses access to once reached. */
const POST_BOOKING_STAGES = new Set(["booking_confirmed", "converted"]);

/** True for Booking Confirmed / Converted — used to trigger the Sales -> Reception
 *  handoff regardless of whether a card lands on booking_confirmed or is dragged
 *  straight to converted (the kanban doesn't enforce sequential stage order). */
export function isPostBookingStage(stage: string): boolean {
  return POST_BOOKING_STAGES.has(stage);
}

/**
 * False if:
 *  - `roles` holds "leads.preBookingOnly" (Sales) and `stage` is at or past
 *    Booking Confirmed — Sales works a lead up to the close, then it's
 *    handed off to Reception (see the auto-unassign in the stage-transition
 *    routes); or
 *  - `roles` holds "leads.consultationOnly" (Doctor) and `stage` isn't
 *    doctor_consultation — Doctor sees only that one column, org-wide; or
 *  - `stage` is "staff" and the role isn't ADMIN — the Staff parking column
 *    is Admin-only, for every other role (including Manager).
 * Every other ownership check stays as-is; this is an extra AND on top.
 */
export function canWorkLeadStage(roles: AppRole[], stage: string): boolean {
  if (can(roles, "leads.preBookingOnly") && POST_BOOKING_STAGES.has(stage)) return false;
  if (can(roles, "leads.consultationOnly") && stage !== "doctor_consultation") return false;
  if (stage === "staff" && !isAdmin(roles)) return false;
  return true;
}

/**
 * Whether `roles` may SEE a lead at `stage` — the read counterpart of
 * canWorkLeadStage, which stays the gate for changing anything.
 *
 * The two were one function until Doctor Admin, whose whole point is that the
 * answers differ: it reads the entire board and edits only Doctor
 * Consultation. Splitting them is what stops "can look at a Converted lead"
 * from also meaning "can edit a Converted lead" — so every read path calls
 * this and every write path keeps calling canWorkLeadStage.
 *
 * The Staff column stays admin-only here too. It is a parking lane rather
 * than a stage of the pipeline, and no non-admin role has ever seen it.
 */
export function canViewLeadStage(roles: AppRole[], stage: string): boolean {
  // The Staff lane has its own read permission rather than riding on
  // leads.viewAllStages: Doctor Admin holds that and must NOT see this
  // column, while a read-only Viewer must. Working it is still admin-only —
  // canWorkLeadStage refuses independently.
  if (stage === "staff") return can(roles, "leads.viewStaffLane");
  if (can(roles, "leads.viewAllStages")) return true;
  return canWorkLeadStage(roles, stage);
}

// ---------------------------------------------------------------------------
// Navigation — each item lists the permission that reveals it.
// ---------------------------------------------------------------------------
export interface NavItem {
  href: string;
  label: string;
  icon: string; // lucide icon name
  /** Any ONE of these reveals the item — most items have a single manage
   *  permission; a few also accept a read-only "*.view" counterpart. */
  perm: Permission | Permission[];
}

export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard", perm: "dashboard.view" },
  { href: "/leads", label: "Leads", icon: "Users", perm: "leads.view" },
  { href: "/guests", label: "Guests", icon: "UserSearch", perm: "guests.view" },
  { href: "/tasks", label: "Tasks", icon: "ListTodo", perm: "leads.view" },
  { href: "/health", label: "Health Records", icon: "HeartPulse", perm: "health.view" },
  { href: "/packages", label: "Packages", icon: "Package", perm: ["packages.manage", "packages.view"] },
  { href: "/referrals", label: "Referrals", icon: "Ticket", perm: ["referrals.manage", "referrals.view"] },
  { href: "/resources", label: "Resources", icon: "FolderOpen", perm: "documents.operational" },
  { href: "/reports", label: "Reports", icon: "BarChart3", perm: "reports.own" },
  { href: "/calls", label: "Calls", icon: "Phone", perm: "reports.allStaff" },
  { href: "/activity", label: "Activity Log", icon: "History", perm: "reports.allStaff" },
  { href: "/deleted", label: "Deleted Leads", icon: "Trash2", perm: ["leads.delete", "leads.viewDeleted"] },
  { href: "/ai-decisions", label: "AI Audit", icon: "ShieldCheck", perm: "ai.audit" },
  { href: "/ask-db", label: "Ask the Database", icon: "Database", perm: "db.query" },
  { href: "/users", label: "Users", icon: "UserCog", perm: ["users.manage", "users.view"] },
  { href: "/permissions", label: "Permissions", icon: "ShieldCheck", perm: "users.manage" },
  { href: "/whatsapp-numbers", label: "WhatsApp Numbers", icon: "MessageCircle", perm: ["whatsapp.manage", "whatsapp.view"] },
  { href: "/autoreplies", label: "Auto-Reply", icon: "Bot", perm: ["whatsapp.manage", "whatsapp.view"] },
  // messaging.viewStatus ONLY (Admin/Manager/Viewer). NOT messaging.send or
  // messaging.broadcast: Front Office, Sales and the Doctor roles all send
  // and broadcast, and this page exposes every campaign the org has ever
  // run — recipient lists, message bodies and who sent them — which is a
  // reporting view, not a sending tool.
  { href: "/broadcast-status", label: "Broadcast Status", icon: "Send", perm: "messaging.viewStatus" },
  { href: "/lead-assignment", label: "Lead Assignment", icon: "Shuffle", perm: ["leads.manage", "lead-assignment.view"] },
  { href: "/sheet-check", label: "Lead Sheet Check", icon: "FileCheck", perm: ["leads.manage", "lead-assignment.view"] },
  { href: "/message-templates", label: "Message Templates", icon: "LayoutTemplate", perm: ["leads.manage", "templates.view"] },
  { href: "/settings", label: "Settings", icon: "Settings", perm: "leads.view" },
];

function hasNavPerm(roles: AppRole[], perm: Permission | Permission[]): boolean {
  return Array.isArray(perm) ? canAny(roles, perm) : can(roles, perm);
}

export function navFor(roles: AppRole[]): NavItem[] {
  // Settings is available to every authenticated user; everything else is
  // gated by its permission.
  return NAV.filter(
    (item) => item.href === "/settings" || hasNavPerm(roles, item.perm),
  );
}

// ---------------------------------------------------------------------------
// Document access by category (tech spec §6.7).
//   medical / consent → Doctor & Admin only
//   operational       → all roles read; Admin/Manager/Reception upload; Staff read-only
//   marketing         → all roles read; Admin/Manager upload
// ---------------------------------------------------------------------------
/**
 * Every document category, in one place. THE list — the Prisma enum, the
 * upload schema (lib/validation), the permission checks below and the
 * Resources UI all key off it. It used to be written out separately in each,
 * and adding `private` to some but not others meant an upload of that
 * category was rejected by the schema before it ever reached a permission
 * check, with nothing logged server-side to say why.
 */
export const DOC_CATEGORIES = [
  "medical",
  "consent",
  "operational",
  "marketing",
  "private",
] as const;

export type DocCategory = (typeof DOC_CATEGORIES)[number];

export function canReadDocCategory(roles: AppRole[], c: DocCategory): boolean {
  // Deliberately its OWN permission, not folded into documents.medical:
  // internal files and guests' medical records are different sensitivities,
  // and granting someone the rate card must never also hand them health data.
  if (c === "private") return can(roles, "documents.private");
  if (c === "medical" || c === "consent") return can(roles, "documents.medical");
  return can(roles, "documents.operational");
}

export function canUploadDocCategory(roles: AppRole[], c: DocCategory): boolean {
  // Read-only by design — checked FIRST and for every category, not just
  // operational. Viewer now holds documents.medical and documents.private so
  // it can READ those shelves; without this check that grant would also have
  // handed it the ability to upload into them, which is the opposite of what
  // a read-only role means.
  const READ_ONLY_ROLES: AppRole[] = ["STAFF", "VIEWER"];
  if (roles.length > 0 && roles.every((r) => READ_ONLY_ROLES.includes(r))) return false;

  if (c === "private") return can(roles, "documents.private");
  if (c === "medical" || c === "consent") return can(roles, "documents.medical");
  if (c === "marketing") return roles.includes("ADMIN") || roles.includes("MANAGER");
  return can(roles, "documents.operational");
}

/**
 * May this role send from a WhatsApp number of this integration?
 *
 * The official Cloud API number is restricted: it is the only number that has
 * never been banned, it carries the WABA's quality rating, and everything
 * outbound-first depends on it. Baileys numbers stay open to everyone who can
 * message at all — losing one is recoverable, losing this is not.
 */
export function canUseWhatsAppIntegration(
  roles: AppRole[],
  integration: string | null | undefined,
): boolean {
  if (integration !== "cloud_api") return true;
  return can(roles, "messaging.cloudApi");
}

/**
 * May this role read ANY guest's correspondence and documents, or only those
 * for guests it personally owns?
 *
 * Reading a mailbox thread exposes senders, subjects and full HTML bodies, so
 * it is ownership-scoped by default (F14 — otherwise any logged-in user could
 * walk guest ids and read arbitrary correspondence).
 *
 * The org-wide grant used to be spelled `leads.manage || health.view` — a
 * WRITE permission standing in for a read capability. That is why a
 * read-only Viewer, which by definition owns no leads, hit "You can only view
 * conversations for your own guests" on every guest in the CRM: it could see
 * the board and the Activity Log but not a single thread. leads.viewAllStages
 * is the read-side equivalent and belongs here alongside them.
 */
export function canReadAllGuestData(roles: AppRole[]): boolean {
  return (
    can(roles, "leads.manage") ||
    can(roles, "health.view") ||
    can(roles, "leads.viewAllStages")
  );
}

export function canDeleteDocuments(roles: AppRole[]): boolean {
  return roles.includes("ADMIN");
}

/** Categories a user may see/select in the UI. */
export function readableDocCategories(roles: AppRole[]): DocCategory[] {
  return DOC_CATEGORIES.filter((c) => canReadDocCategory(roles, c));
}

/** Route prefixes that require a permission — any ONE of a list (used by middleware). */
export const ROUTE_GUARDS: Array<{ prefix: string; perm: Permission | Permission[] }> = [
  { prefix: "/dashboard", perm: "dashboard.view" },
  { prefix: "/guests", perm: "guests.view" },
  { prefix: "/health", perm: "health.view" },
  { prefix: "/packages", perm: ["packages.manage", "packages.view"] },
  { prefix: "/referrals", perm: ["referrals.manage", "referrals.view"] },
  { prefix: "/ai-decisions", perm: "ai.audit" },
  { prefix: "/ask-db", perm: "db.query" },
  { prefix: "/activity", perm: "reports.allStaff" },
  // leads.delete is ADMIN-only — a deleted lead's archive carries its full
  // message and call history, so this is deliberately narrower than the
  // Activity Log's reports.allStaff (which MANAGER also holds).
  { prefix: "/deleted", perm: ["leads.delete", "leads.viewDeleted"] },
  { prefix: "/users", perm: ["users.manage", "users.view"] },
  // users.manage only (ADMIN) — VIEWER holds users.view and can see the staff
  // list, but this page also spells out every sensitive capability in the
  // system and lets roles be reassigned.
  { prefix: "/permissions", perm: "users.manage" },
  { prefix: "/whatsapp-numbers", perm: ["whatsapp.manage", "whatsapp.view"] },
  { prefix: "/autoreplies", perm: ["whatsapp.manage", "whatsapp.view"] },
  { prefix: "/broadcast-status", perm: "messaging.viewStatus" },
  { prefix: "/lead-assignment", perm: ["leads.manage", "lead-assignment.view"] },
  { prefix: "/sheet-check", perm: ["leads.manage", "lead-assignment.view"] },
  { prefix: "/message-templates", perm: ["leads.manage", "templates.view"] },
];
