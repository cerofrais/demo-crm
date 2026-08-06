# 10 — Roles & logins

This is the quick reference for **who can log in, with what password, and what
they can see**. Identity is managed by Keycloak (realm `tre-wellness`); the CRM
reads roles from the login token. Full enforcement detail is in
[06 — RBAC](./06-rbac.md).

> ⚠️ **These are development credentials.** Before any real deployment, change
> every password, rotate `KEYCLOAK_CLIENT_SECRET`, and remove or replace the
> seeded test users. See "Going to production" below.

## Test users (seeded)

All seeded users share the password **`Password123!`**. Sign in at
http://localhost:3000 → **Continue with Keycloak**.

| Username    | Password        | Role (Keycloak)  | CRM role     | Lands on        |
| ----------- | --------------- | ---------------- | ------------ | --------------- |
| `admin`     | `Password123!`  | `crm-admin`      | Administrator | Dashboard      |
| `manager`   | `Password123!`  | `crm-manager`    | Manager       | Dashboard      |
| `doctor`    | `Password123!`  | `crm-doctor`     | Doctor        | Health Records |
| `reception` | `Password123!`  | `crm-reception`  | Front Office  | Leads (Kanban) |
| `staff`     | `Password123!`  | `crm-staff`      | Staff         | Leads (read-only) |

There's no seeded test user for `crm-sales` (Sales) or `crm-viewer` (Viewer)
— create one via the in-app Users page (see
[16 — User management](./16-user-management.md)) when you need to test that role.

Keycloak **admin console**: http://localhost:8080 — log in with
`KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` from your `.env`
(defaults: `admin` / `change-me-kc-admin`).

## What each role can do

| Capability                | Admin | Manager | Doctor | Front Office (Reception) | Sales | Staff | Viewer |
| ------------------------- | :---: | :-----: | :----: | :----------------------: | :---: | :---: | :----: |
| Dashboard (org analytics) |  ✅   |   ✅    |   —    |            —             |   —   |   —   |  read  |
| Leads — Kanban & list     |  ✅   |   ✅    | Doctor Consultation only§ |     own + unassigned     | own + unassigned‡ | read | read (all) |
| Move/assign any lead      |  ✅   |   ✅    |   —    |     own (drag-to-claim)  | own (drag-to-claim)‡ |   —   |   —    |
| Guests directory          |  ✅   |   ✅    |  ✅*   |            ✅            |  —†   |  ✅   |  read  |
| Health records (encrypted)|  ✅   |   —     |   ✅   |            —             |   —   |   —   |   —    |
| Tasks / 6-2-1 reminders   |  ✅   |   ✅    |   —    |            ✅            |  ✅   |  ✅   |  read (all) |
| Resources — operational   |  ✅   |   ✅    |   —    |     read + upload        | read + upload |  read |  read  |
| Resources — medical/consent|  ✅  |   —     |   ✅   |            —             |   —   |   —   |   —    |
| Packages & memberships    |  ✅   |   ✅    |   —    |            —             |   —   |   —   |  read  |
| Referral codes & QR       |  ✅   |   ✅    |   —    |            —             |   —   |   —   |  read  |
| Reports (all staff)       |  ✅   |   ✅    |   —    |            —             |   —   |   —   |  read  |
| Reports (own performance) |  ✅   |   ✅    |   —    |            ✅            |  ✅   |   —   |  read  |
| Calls & Activity Log      |  ✅   |   ✅    |   —    |            —             |   —   |   —   |  read  |
| Lead Assignment config    |  ✅   |   ✅    |   —    |            —             |   —   |   —   |  read  |
| Message Templates         |  ✅   |   ✅    |   —    |            —             |   —   |   —   |  read  |
| WhatsApp Numbers          |  ✅   |   —     |   —    |            —             |   —   |   —   |  read  |
| User management (Keycloak)|  ✅   |   —     |   —    |            —             |   —   |   —   |  read  |

\* Doctor reaches guests via the **Health Records** search. Settings is available
to everyone.

† Sales is the one role without the standalone Guests directory — it works
leads, not guest lookups. Guest data reached *through* an owned lead (the
WhatsApp/email tabs in the lead drawer) is unaffected; Sales can still
message its own leads' guests.

‡ Sales works a lead up to **Booking Confirmed**. The moment a lead reaches
that stage it's automatically unassigned and Sales loses all access to it —
it goes back to the unassigned queue for Reception to pick up from there.

§ Doctor's Leads page shows **only** the Doctor Consultation column — every
lead currently in it, org-wide, not scoped to any one doctor. Still can't
move cards, create leads, or edit notes/tags/tasks — but they can now record
an Accept / Reject / Needs-phone-consult decision on each one (a banner in
the lead drawer, shipped 2026-07-23 — see [18 — Client roadmap](./18-client-roadmap.md)).

### Role intent in one line each
- **Administrator** — full access, including Keycloak user management and DPDP/compliance actions.
- **Manager** — runs the whole pipeline, packages, referrals and sees all-staff performance; no access to medical data.
- **Doctor** — medical screening profiles and medical/consent documents only; no sales pipeline.
- **Front Office (Reception)** — works their own leads plus the unassigned queue; messaging, tasks, own performance.
- **Sales** — same day-to-day access as Reception, but scoped to the pre-booking pipeline only (handed off to Reception at Booking Confirmed) and without the standalone Guests directory.
- **Staff** — read-only on assigned work and guest names.
- **Viewer** — read-only across almost the whole app (Leads org-wide, Guests, Reports, Calls, Activity, Packages, Referrals, Message Templates, Lead Assignment, WhatsApp Numbers, Users), with zero create/edit/delete/send anywhere and no access to Health Records or medical/consent documents. For an auditor, investor, or consultant who needs visibility without any ability to change data.

## Adding or changing users (Keycloak admin console)

1. Go to http://localhost:8080 → sign in as the Keycloak admin.
2. Top-left realm switcher → select **tre-wellness**.
3. **Users → Add user** → fill username/email → Create.
4. **Credentials** tab → Set password (toggle *Temporary* off for a permanent one).
5. **Role mapping** tab → **Assign role** → pick one of `crm-admin`,
   `crm-manager`, `crm-doctor`, `crm-reception`, `crm-sales`, `crm-staff`,
   `crm-viewer`.
6. The new role takes effect on the user's next login (roles come from the token).

To change a password: **Users → (pick user) → Credentials → Reset password**.

## How roles flow into the app

```
Keycloak realm role   →   CRM role     →   permissions (src/lib/rbac.ts)
crm-admin             →   ADMIN        →   everything
crm-manager           →   MANAGER      →   pipeline, packages, referrals, reports…
crm-doctor            →   DOCTOR       →   health.view, documents.medical
crm-reception         →   RECEPTION    →   leads.ownOnly, messaging, reports.own
crm-staff             →   STAFF        →   leads.view (read), documents.operational (read)
crm-viewer            →   VIEWER       →   every *.view permission — read-only, no Health Records
```

A user with **no** `crm-*` role can authenticate but will have no permissions
(they'll be bounced to the leads screen with nothing visible). Always assign a role.

## Going to production (security checklist)

- [ ] Change `KEYCLOAK_ADMIN_PASSWORD`, all DB passwords, `STORAGE_SECRET_KEY`.
- [ ] Rotate the `tre-crm` client secret (Clients → tre-crm → Credentials → Regenerate) and update `KEYCLOAK_CLIENT_SECRET`.
- [ ] Generate fresh `NEXTAUTH_SECRET` (`openssl rand -base64 32`) and `HEALTH_ENCRYPTION_KEY` (`openssl rand -hex 32`).
- [ ] Delete the five seeded test users; create real staff accounts.
- [ ] Enable MFA (TOTP) for `crm-admin` and `crm-doctor` (realm → Authentication).
- [ ] Put Keycloak behind a stable hostname/HTTPS (see [05 — Auth](./05-auth-keycloak.md)).
