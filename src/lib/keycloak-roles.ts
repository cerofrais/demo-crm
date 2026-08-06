/**
 * The 5 Keycloak realm roles and their CRM app-role mapping — pure data, no
 * server-only imports, so both client components and server code (including
 * validation.ts, which client forms import) can safely depend on it.
 * Keycloak API calls live in ./keycloak-admin.ts (server-only).
 */
import type { AppRole } from "./rbac";

export const CRM_ROLES = [
  "crm-admin",
  "crm-doctor",
  "crm-manager",
  "crm-reception",
  "crm-sales",
  "crm-staff",
  "crm-viewer",
] as const;
export type CrmRole = (typeof CRM_ROLES)[number];

export const CRM_ROLE_TO_APP_ROLE: Record<CrmRole, AppRole> = {
  "crm-admin": "ADMIN",
  "crm-doctor": "DOCTOR",
  "crm-manager": "MANAGER",
  "crm-reception": "RECEPTION",
  "crm-sales": "SALES",
  "crm-staff": "STAFF",
  "crm-viewer": "VIEWER",
};
