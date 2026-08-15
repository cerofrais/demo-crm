/**
 * Role-Based Access Control — single source of truth for the spec's §8 matrix.
 * Keycloak realm roles map to CRM app roles; permissions are derived from role.
 * Used in middleware (route gating), API handlers, and to filter the sidebar.
 */

export type AppRole = "ADMIN" | "DOCTOR" | "MANAGER" | "RECEPTION" | "SALES" | "STAFF" | "VIEWER";

export const KEYCLOAK_ROLE_MAP: Record<string, AppRole> = {
  "crm-admin": "ADMIN",
  "crm-doctor": "DOCTOR",
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
  | "leads.doctorDecision" // record Accept/Reject/Needs-phone-consult on a consultation-stage lead — doctor only
  | "leads.delete" // delete a lead ticket — admin only
  | "guests.delete" // delete a guest record — admin only
  | "health.view"
  | "messaging.send"
  | "messaging.broadcast" // mass-send: broadcasts + bulk email to the guest directory
  | "documents.medical"
  | "documents.operational"
  | "packages.manage"
  | "packages.view" // see packages without create/edit/deactivate — implied by packages.manage too
  | "referrals.manage"
  | "referrals.view" // see referral codes without creating new ones
  | "reports.allStaff"
  | "reports.own"
  | "users.manage"
  | "users.view" // see the Users list without create/edit/delete/reset-password/routing config
  | "ai.audit" // view the AI/ML decision log (prompts + outputs) — admin only
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
    "documents.medical",
    "documents.operational",
    "packages.manage",
    "referrals.manage",
    "reports.allStaff",
    "reports.own",
    "users.manage",
    "ai.audit",
    "whatsapp.manage",
    "leads.delete",
    "guests.delete",
  ],
  MANAGER: [
    "dashboard.view",
    "leads.view",
    "guests.view",
    "leads.manage",
    "messaging.send",
    "messaging.broadcast",
    "documents.operational",
    "packages.manage",
    "referrals.manage",
    "reports.allStaff",
    "reports.own",
  ],
  // Sees the Leads page, but restricted to only the Doctor Consultation
  // column, org-wide (not scoped to any single doctor's own leads — there's
  // no per-doctor assignment concept on Enquiry).
  DOCTOR: [
    "health.view",
    "documents.medical",
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
  // Read-only across almost the whole app — every ".view" permission that
  // exists, none of the ".manage"/"ownOnly"/"delete"/"send" ones. Deliberately
  // excludes health.view/documents.medical (no Health Records access) per the
  // access decision made when this role was added — everything else visible.
  VIEWER: [
    "dashboard.view",
    "leads.view",
    "guests.view",
    "documents.operational",
    "reports.allStaff",
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
  const order: AppRole[] = ["ADMIN", "MANAGER", "DOCTOR", "RECEPTION", "SALES", "STAFF", "VIEWER"];
  return order.find((r) => roles.includes(r));
}

export const ROLE_LABEL: Record<AppRole, string> = {
  ADMIN: "Administrator",
  DOCTOR: "Doctor",
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
  { href: "/deleted", label: "Deleted Leads", icon: "Trash2", perm: "leads.delete" },
  { href: "/ai-decisions", label: "AI Audit", icon: "ShieldCheck", perm: "ai.audit" },
  { href: "/users", label: "Users", icon: "UserCog", perm: ["users.manage", "users.view"] },
  { href: "/permissions", label: "Permissions", icon: "ShieldCheck", perm: "users.manage" },
  { href: "/whatsapp-numbers", label: "WhatsApp Numbers", icon: "MessageCircle", perm: ["whatsapp.manage", "whatsapp.view"] },
  { href: "/autoreplies", label: "Auto-Reply", icon: "Bot", perm: ["whatsapp.manage", "whatsapp.view"] },
  { href: "/broadcast-status", label: "Broadcast Status", icon: "Send", perm: "messaging.send" },
  { href: "/lead-assignment", label: "Lead Assignment", icon: "Shuffle", perm: ["leads.manage", "lead-assignment.view"] },
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
export type DocCategory = "medical" | "consent" | "operational" | "marketing";

export function canReadDocCategory(roles: AppRole[], c: DocCategory): boolean {
  if (c === "medical" || c === "consent") return can(roles, "documents.medical");
  return can(roles, "documents.operational");
}

export function canUploadDocCategory(roles: AppRole[], c: DocCategory): boolean {
  if (c === "medical" || c === "consent") return can(roles, "documents.medical");
  if (c === "marketing") return roles.includes("ADMIN") || roles.includes("MANAGER");
  // operational: everyone with the permission EXCEPT roles that are
  // read-only by design (Staff, Viewer) — i.e. every role held is one of
  // those, with no upload-capable role mixed in.
  const READ_ONLY_ROLES: AppRole[] = ["STAFF", "VIEWER"];
  return (
    can(roles, "documents.operational") && !roles.every((r) => READ_ONLY_ROLES.includes(r))
  );
}

export function canDeleteDocuments(roles: AppRole[]): boolean {
  return roles.includes("ADMIN");
}

/** Categories a user may see/select in the UI. */
export function readableDocCategories(roles: AppRole[]): DocCategory[] {
  return (["medical", "consent", "operational", "marketing"] as DocCategory[]).filter(
    (c) => canReadDocCategory(roles, c),
  );
}

/** Route prefixes that require a permission — any ONE of a list (used by middleware). */
export const ROUTE_GUARDS: Array<{ prefix: string; perm: Permission | Permission[] }> = [
  { prefix: "/dashboard", perm: "dashboard.view" },
  { prefix: "/guests", perm: "guests.view" },
  { prefix: "/health", perm: "health.view" },
  { prefix: "/packages", perm: ["packages.manage", "packages.view"] },
  { prefix: "/referrals", perm: ["referrals.manage", "referrals.view"] },
  { prefix: "/ai-decisions", perm: "ai.audit" },
  { prefix: "/activity", perm: "reports.allStaff" },
  // leads.delete is ADMIN-only — a deleted lead's archive carries its full
  // message and call history, so this is deliberately narrower than the
  // Activity Log's reports.allStaff (which MANAGER also holds).
  { prefix: "/deleted", perm: "leads.delete" },
  { prefix: "/users", perm: ["users.manage", "users.view"] },
  // users.manage only (ADMIN) — VIEWER holds users.view and can see the staff
  // list, but this page also spells out every sensitive capability in the
  // system and lets roles be reassigned.
  { prefix: "/permissions", perm: "users.manage" },
  { prefix: "/whatsapp-numbers", perm: ["whatsapp.manage", "whatsapp.view"] },
  { prefix: "/autoreplies", perm: ["whatsapp.manage", "whatsapp.view"] },
  { prefix: "/broadcast-status", perm: "messaging.send" },
  { prefix: "/lead-assignment", perm: ["leads.manage", "lead-assignment.view"] },
  { prefix: "/message-templates", perm: ["leads.manage", "templates.view"] },
];
