# 06 — Role-Based Access Control

Roles are read from the Keycloak JWT on every request. Enforced in two layers:
**middleware** (route gating) and **API handlers** (`requirePermission`). The
sidebar is also filtered by permission, so users only see what they can use.

Source of truth: [`src/lib/rbac.ts`](../src/lib/rbac.ts).

## Roles

| Keycloak role   | App role   | Summary |
| --------------- | ---------- | ------- |
| `crm-admin`     | ADMIN      | Full access incl. user management & analytics |
| `crm-manager`   | MANAGER    | Full pipeline, packages, referrals, all-staff reports; no health data |
| `crm-doctor`    | DOCTOR     | Health profiles & medical docs; Leads page restricted to the Doctor Consultation column only |
| `crm-reception` | RECEPTION  | Own leads + unassigned queue, messaging, own reports |
| `crm-sales`     | SALES      | Same as Reception, but loses a lead once it reaches Booking Confirmed, and has no Guests-directory access |
| `crm-staff`     | STAFF      | Read-only assigned tasks & guest names |
| `crm-viewer`    | VIEWER     | Read-only across almost the whole app (every `*.view` permission); no Health Records access |

## Permission matrix

| Capability                | ADMIN | DOCTOR | MANAGER | RECEPTION | SALES | STAFF | VIEWER |
| ------------------------- | :---: | :----: | :-----: | :-------: | :---: | :---: | :----: |
| Dashboard (org analytics) |  ✅   |   —    |   ✅    |     —     |   —   |   —   |  read  |
| Leads — view              |  ✅   | consult‡ |   ✅    |    own*   | own*† |  ✅   | read (all) |
| Leads — manage (all)      |  ✅   |   —    |   ✅    |     —     |   —   |   —   |   —    |
| Leads — own only          |  ✅   |   —    |   ✅    |    ✅     |   ✅  |   —   |   —    |
| Leads — delete ticket     |  ✅   |   —    |    —    |     —     |   —   |   —   |   —    |
| Doctor consultation decision |  —  |   ✅   |    —    |     —     |   —   |   —   |   —    |
| Guests directory          |  ✅   |   ✅   |   ✅    |    ✅     |   —   |  ✅   |  read  |
| Health profiles           |  ✅   |   ✅   |    —    |     —     |   —   |   —   |   —    |
| Send WhatsApp / Email     |  ✅   |   —    |   ✅    |   own     |  own  |   —   |   —    |
| Documents — medical       |  ✅   |   ✅   |    —    |     —     |   —   |   —   |   —    |
| Documents — operational   |  ✅   |   —    |   ✅    |    ✅     |   ✅  |  read |  read  |
| Packages & memberships    |  ✅   |   —    |   ✅    |     —     |   —   |   —   |  read  |
| Referral codes            |  ✅   |   —    |   ✅    |     —     |   —   |   —   |  read  |
| Reports — all staff       |  ✅   |   —    |   ✅    |     —     |   —   |   —   |  read  |
| Reports — own             |  ✅   |   —    |   ✅    |    ✅     |   ✅  |   —   |  read  |
| Calls & Activity Log      |  ✅   |   —    |   ✅    |     —     |   —   |   —   |  read  |
| Lead Assignment config    |  ✅   |   —    |   ✅    |     —     |   —   |   —   |  read  |
| Message Templates         |  ✅   |   —    |   ✅    |     —     |   —   |   —   |  read  |
| User management           |  ✅   |   —    |    —    |     —     |   —   |   —   |  read  |
| WhatsApp number management|  ✅   |   —    |    —    |     —     |   —   |   —   |  read  |

\* Reception/Sales see their **own** leads plus the **unassigned** queue (so
they can pick up new leads); moving a card assigns it to them.

Guests directory is the standalone `/guests` search page, gated by its own
`guests.view` permission — separate from `leads.view` (which every role
holds, since it also gates Tasks) specifically so Sales can be excluded from
it without losing Leads/Tasks. Guest data reached *through* an owned lead —
the WhatsApp/email tabs in the lead drawer — is unaffected; Sales can still
message its own leads' guests either way.

† Sales additionally loses a lead the moment it reaches **Booking Confirmed**:
the lead is automatically unassigned (landing back in the unassigned queue
for Reception) and Sales can no longer view or act on it at all from that
point on, even if directly reassigned back to them later — see
`canWorkLeadStage()` in [`src/lib/rbac.ts`](../src/lib/rbac.ts).

‡ Doctor sees **only** the Doctor Consultation column — every other stage is
invisible to them, both in the UI and at the API level — but unlike Sales/
Reception it's **not** scoped by assignee: they see every lead currently in
that column, org-wide (there's no per-doctor assignment concept on
`Enquiry`). Doctor has neither `leads.manage` nor `leads.ownOnly`, so they
still can't move a card, add notes/tasks, or edit tags — "New lead" is
hidden and the Kanban board renders just the one column. The API-level
filter is the same `canWorkLeadStage()` used for Sales, via the
`leads.consultationOnly` permission. The one thing Doctor *can* do is record
an Accept/Reject/Needs-phone-consult decision (a banner in the lead drawer,
gated by the separate `leads.doctorDecision` permission — see
`PATCH /api/enquiries/:id/doctor-decision`) — entering the stage also opens
an unassigned "review" task any doctor can pick up, though since Doctor
lacks `reports.allStaff` their actual discovery surface is a "Needs review"
badge on the Kanban card itself, not the Tasks page.

"Leads — delete ticket" is a trash icon in the lead drawer header, Admin
only. It's a **soft delete** (`Enquiry.deletedAt`) — the ticket disappears
from the board and reports, but its notes, tasks, calls and messages stay in
the database; nothing is destroyed.

"User management" is the `/users` page (Keycloak-backed — create, edit,
disable, reset password, delete staff accounts) — see
[16 — User management](./16-user-management.md).

"WhatsApp number management" is the `/whatsapp-numbers` page (onboard/rename/
disconnect numbers, set the default). Once a number is connected, everyone
with "Send WhatsApp / Email" can send/receive from it — that permission row
covers day-to-day WhatsApp use, this row only covers connecting/removing
numbers. See [17 — WhatsApp integration](./17-whatsapp-integration.md).

**VIEWER** is deliberately the odd one out — every other role's permissions
are shaped around a specific job (own leads, medical data, admin). VIEWER
holds one `*.view` permission per area instead, generated by
`canAny([manage, view])` checks on the pages/routes that previously only
accepted the manage permission (`packages.view`, `referrals.view`,
`users.view`, `whatsapp.view`, `lead-assignment.view`, `templates.view`).
Leads specifically uses a new `canMutateLeads()` helper
(`leads.manage || leads.ownOnly || leads.consultationOnly`) rather than bare
`leads.view`, since several lead-mutation routes (field edits, remarks,
tasks) had previously — and incorrectly — accepted any `leads.view` holder;
this was tightened as part of adding VIEWER, which also correctly locked
STAFF out of those same routes (STAFF was never meant to edit leads either,
per its "read-only" role summary above, but held the same loophole).

## How it's enforced

- **Routes:** `ROUTE_GUARDS` in `rbac.ts` lists prefix → required permission;
  `src/middleware.ts` redirects unauthorised users to `/leads`.
- **APIs:** handlers call `requireSession()` / `requirePermission(perm)` from
  `src/lib/api.ts`, returning `401` / `403` with the standard error envelope.
- **Landing page:** `/` routes each role to its natural first screen — Admin/
  Manager → Dashboard, Doctor → Health, others → Leads.

## Adding a capability

1. Add the `Permission` string + assign it to roles in `PERMISSIONS` (`rbac.ts`).
2. If it's a whole route, add a `NAV` entry and (if admin-only) a `ROUTE_GUARDS`
   entry.
3. Guard the API with `requirePermission("your.perm")`.
