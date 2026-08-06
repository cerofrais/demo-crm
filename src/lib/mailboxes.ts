import type { AppRole } from "./rbac";

/**
 * Role-based mailbox registry (env-driven).
 *
 * Trē uses a small set of shared mailboxes, not one per user:
 *   • "sales"  — all sales roles (Admin/Manager/Reception/Staff) send & receive here
 *                (dev: harsha@ascent-i-tech.in; prod: hello@trewellness.in)
 *   • "doctor" — the doctor's own mailbox; separate conversations
 *
 * Each mailbox is configured via env with a PREFIX (SALES_ / DOCTOR_). A mailbox
 * with no SMTP credentials is treated as "not configured" (compose disabled, the
 * inbound poller skips it) so the doctor mailbox can be added later without code
 * changes.
 */
export type MailboxId = "sales" | "doctor";

export interface MailboxConfig {
  id: MailboxId;
  label: string;
  /** From/Reply-To header, e.g. "Trē Wellness <harsha@ascent-i-tech.in>" */
  from: string;
  /** bare address parsed from `from` */
  address: string;
  /** Unknown inbound here auto-creates a lead (sales only). */
  createsLeads: boolean;
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string };
  imap: { host: string; port: number; user: string; pass: string };
  /** true when SMTP creds are present */
  configured: boolean;
}

function parseAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

/**
 * Parse an env boolean tolerantly. Previously `secure` was `=== "true"`, so
 * `SMTP_SECURE=1` (or TRUE/yes/on) silently resolved to false — nodemailer then
 * opened a plaintext socket to an implicit-TLS port (:465) and hung, failing
 * every outbound email. Accept the common truthy spellings.
 */
function envBool(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function buildMailbox(
  id: MailboxId,
  prefix: string,
  label: string,
  createsLeads: boolean,
): MailboxConfig {
  const e = process.env;
  const user = e[`${prefix}_SMTP_USER`] ?? "";
  const pass = e[`${prefix}_SMTP_PASS`] ?? "";
  const address = e[`${prefix}_SMTP_USER`] ?? "";
  const from = e[`${prefix}_FROM`] ?? (address ? `Trē Wellness <${address}>` : "");
  return {
    id,
    label,
    from,
    address: parseAddress(from || address),
    createsLeads,
    smtp: {
      host: e[`${prefix}_SMTP_HOST`] ?? "smtp.gmail.com",
      port: Number(e[`${prefix}_SMTP_PORT`] ?? 587),
      secure: envBool(e[`${prefix}_SMTP_SECURE`], false),
      user,
      pass,
    },
    imap: {
      host: e[`${prefix}_IMAP_HOST`] ?? "imap.gmail.com",
      port: Number(e[`${prefix}_IMAP_PORT`] ?? 993),
      user: e[`${prefix}_IMAP_USER`] ?? user,
      pass: e[`${prefix}_IMAP_PASS`] ?? pass,
    },
    // Configured = we have an identity + an SMTP host to send through. Auth is
    // optional so a dev SMTP sink (Mailhog, no auth) works; real providers
    // (Gmail) supply user+pass and the transport uses them.
    configured: Boolean(from && e[`${prefix}_SMTP_HOST`]),
  };
}

export function allMailboxes(): MailboxConfig[] {
  return [
    buildMailbox("sales", "SALES", "Sales", true),
    buildMailbox("doctor", "DOCTOR", "Doctor", false),
  ];
}

export function getMailbox(id: MailboxId): MailboxConfig | undefined {
  return allMailboxes().find((m) => m.id === id);
}

export function configuredMailboxes(): MailboxConfig[] {
  return allMailboxes().filter((m) => m.configured);
}

/** The mailbox a given user sends from / owns. */
export function mailboxIdForRoles(roles: AppRole[]): MailboxId {
  return roles.includes("DOCTOR") ? "doctor" : "sales";
}

export function mailboxForRoles(roles: AppRole[]): MailboxConfig | undefined {
  return getMailbox(mailboxIdForRoles(roles));
}

/** Mailbox threads a user may view: admins see all configured; others see theirs. */
export function visibleMailboxIds(roles: AppRole[]): MailboxId[] {
  if (roles.includes("ADMIN")) return configuredMailboxes().map((m) => m.id);
  return [mailboxIdForRoles(roles)];
}

/** Sending is allowed for sales roles (messaging.send) and the doctor. */
export function canSendEmail(roles: AppRole[]): boolean {
  return (
    roles.includes("ADMIN") ||
    roles.includes("MANAGER") ||
    roles.includes("RECEPTION") ||
    roles.includes("DOCTOR")
  );
}
