/**
 * Human-readable descriptions of every permission, for the admin Permissions
 * page. Presentation only — `can()` in rbac.ts remains the single source of
 * truth for access decisions, and this file must never be consulted to make
 * one.
 *
 * Kept beside the permission list rather than inside rbac.ts so the
 * authorization table stays short and readable. A permission missing from
 * here still renders (falling back to its raw key), and a test asserts the
 * two lists stay in sync so a newly-added permission can't silently show up
 * undocumented.
 */
import type { Permission } from "./rbac";

export type PermissionGroup =
  | "Leads"
  | "Guests & health"
  | "Messaging"
  | "Documents"
  | "Catalogue"
  | "Reporting"
  | "Administration";

export interface PermissionMeta {
  key: Permission;
  group: PermissionGroup;
  label: string;
  /** What holding this actually lets someone do, in plain terms. */
  description: string;
  /** Flagged in the UI — destructive or privacy-sensitive. */
  sensitive?: boolean;
}

export const PERMISSION_CATALOG: PermissionMeta[] = [
  // ── Leads ──────────────────────────────────────────────────────────────
  { key: "leads.view", group: "Leads", label: "View leads", description: "Open the Leads pipeline and see lead cards." },
  { key: "leads.manage", group: "Leads", label: "Manage all leads", description: "Create, edit, assign and move any lead through the pipeline." },
  { key: "leads.ownOnly", group: "Leads", label: "Own leads only", description: "Restricted to leads assigned to them, plus the unassigned queue." },
  { key: "leads.preBookingOnly", group: "Leads", label: "Pre-booking only", description: "Loses access to a lead once it reaches Booking Confirmed." },
  { key: "leads.consultationOnly", group: "Leads", label: "Consultation stage only", description: "Sees only leads currently in Doctor Consultation, org-wide." },
  { key: "leads.viewAllStages", group: "Leads", label: "View every stage", description: "Sees every column on the board (except the admin-only Staff lane) without gaining the right to change leads outside its own stage." },
  { key: "leads.doctorDecision", group: "Leads", label: "Record doctor decision", description: "Accept / Reject / Needs-phone-consult on a consultation-stage lead." },
  { key: "leads.delete", group: "Leads", label: "Delete leads", description: "Delete a lead, and permanently purge one from the Deleted Leads archive.", sensitive: true },
  { key: "leads.viewDeleted", group: "Leads", label: "Read the deleted-lead archive", description: "Open Deleted Leads and read a deleted ticket, including its message and call history, without being able to purge it.", sensitive: true },
  { key: "leads.viewStaffLane", group: "Leads", label: "See the Staff column", description: "See the Staff parking lane on the board. Moving leads into or out of it stays Admin-only.", sensitive: false },

  // ── Guests & health ────────────────────────────────────────────────────
  { key: "guests.view", group: "Guests & health", label: "View guests", description: "Search and open the Guests directory." },
  { key: "guests.delete", group: "Guests & health", label: "Delete guests", description: "Soft- or hard-delete a guest record and their history.", sensitive: true },
  { key: "health.view", group: "Guests & health", label: "View health records", description: "Open guest medical history and health profiles. Read-only on its own — saving or deleting a record needs 'Edit health records'.", sensitive: true },
  { key: "health.edit", group: "Guests & health", label: "Edit health records", description: "Create, replace or delete a health record. Separate from viewing so a read-only role can be shown records without being able to change them.", sensitive: true },

  // ── Messaging ──────────────────────────────────────────────────────────
  { key: "messaging.send", group: "Messaging", label: "Send messages", description: "Message one guest at a time — email, WhatsApp, click-to-call, edit/delete a sent message." },
  { key: "messaging.broadcast", group: "Messaging", label: "Send broadcasts", description: "Mass-send to many guests at once: WhatsApp broadcasts and bulk email. Does NOT include the Broadcast Status page — that is 'Watch broadcast status'.", sensitive: true },
  { key: "messaging.viewStatus", group: "Messaging", label: "Watch broadcast status", description: "Open Broadcast Status and follow a send's progress, without being able to start or cancel one.", sensitive: false },
  { key: "messaging.cloudApi", group: "Messaging", label: "Use the official WhatsApp number", description: "Send from the Cloud API number. It is the only number that has never been banned and everything outbound-first depends on it, so it is kept to senior staff.", sensitive: true },

  // ── Documents ──────────────────────────────────────────────────────────
  { key: "documents.medical", group: "Documents", label: "Medical documents", description: "Upload and read documents in the medical category.", sensitive: true },
  { key: "documents.private", group: "Documents", label: "Private resources", description: "See and attach restricted Resources files (internal rate cards, contracts). Hidden entirely from everyone else — they are not listed, not searchable, and cannot be attached even with a direct link.", sensitive: true },
  { key: "documents.operational", group: "Documents", label: "Operational documents", description: "Upload and read everyday operational documents and Resources." },

  // ── Catalogue ──────────────────────────────────────────────────────────
  { key: "packages.manage", group: "Catalogue", label: "Manage packages", description: "Create, edit and deactivate wellness packages." },
  { key: "packages.view", group: "Catalogue", label: "View packages", description: "See packages without being able to change them." },
  { key: "referrals.manage", group: "Catalogue", label: "Manage referrals", description: "Create and manage referral codes." },
  { key: "referrals.view", group: "Catalogue", label: "View referrals", description: "See referral codes without creating them." },
  { key: "templates.view", group: "Catalogue", label: "View message templates", description: "See message templates without editing them." },

  // ── Reporting ──────────────────────────────────────────────────────────
  { key: "dashboard.view", group: "Reporting", label: "View dashboard", description: "Org-wide analytics on the Dashboard." },
  { key: "reports.allStaff", group: "Reporting", label: "All-staff reports", description: "Reports across every staff member, plus Calls and the Activity Log." },
  { key: "calls.recording", group: "Reporting", label: "Play call recordings", description: "Listen to and download any call recording, not only their own calls. A rep can always play back a call they were on.", sensitive: true },
  { key: "reports.own", group: "Reporting", label: "Own reports", description: "Their own performance numbers only." },

  // ── Administration ─────────────────────────────────────────────────────
  { key: "users.manage", group: "Administration", label: "Manage users", description: "Create staff accounts, change roles, reset passwords, and open this page.", sensitive: true },
  { key: "users.view", group: "Administration", label: "View users", description: "See the staff list without changing anything." },
  { key: "ai.audit", group: "Administration", label: "AI audit log", description: "Read every AI prompt and output in the AI Audit trail.", sensitive: true },
  { key: "db.query", group: "Administration", label: "Ask the database", description: "Ask questions in plain English and read the answer straight from the database. Read-only, and health records, documents and WhatsApp credentials stay out of reach.", sensitive: true },
  { key: "whatsapp.manage", group: "Administration", label: "Manage WhatsApp numbers", description: "Onboard, reconnect and remove WhatsApp numbers, and manage auto-replies.", sensitive: true },
  { key: "whatsapp.view", group: "Administration", label: "View WhatsApp numbers", description: "See connected numbers without onboarding or removing them." },
  { key: "lead-assignment.view", group: "Administration", label: "View lead assignment", description: "See routing configuration without changing it." },
];

export const PERMISSION_GROUP_ORDER: PermissionGroup[] = [
  "Leads",
  "Guests & health",
  "Messaging",
  "Documents",
  "Catalogue",
  "Reporting",
  "Administration",
];

const BY_KEY = new Map(PERMISSION_CATALOG.map((p) => [p.key, p]));

/** Metadata for a permission, falling back to its raw key if undocumented. */
export function permissionMeta(key: Permission): PermissionMeta {
  return (
    BY_KEY.get(key) ?? {
      key,
      group: "Administration",
      label: key,
      description: "No description recorded for this permission yet.",
    }
  );
}
