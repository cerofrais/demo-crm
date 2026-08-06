# 16 — Adding & managing staff users

Staff identity lives entirely in Keycloak — there is no local "users" table in
the CRM's own database. Three ways to add or manage an account, in order of
how most admins will actually use them day to day.

## The 5 roles

| Keycloak realm role | App role | Can access |
| --- | --- | --- |
| `crm-admin` | Admin | Everything — including the Users page, AI Audit, all-staff Calls, Health Records, Reports |
| `crm-manager` | Manager | All leads and staff performance, Calls admin page, Reports, Packages/Referrals — not AI Audit or Users |
| `crm-reception` | Reception | Own leads plus the unassigned queue; can create and manage leads |
| `crm-doctor` | Doctor | Health Records and their own mailbox conversations only |
| `crm-staff` | Staff | Assigned leads and operational documents only |

Every account gets **exactly one** of these — see [06 — RBAC](./06-rbac.md)
for the full permission matrix.

### Full comparison

| Capability | Admin | Doctor | Manager | Reception | Staff |
| --- | :---: | :---: | :---: | :---: | :---: |
| Dashboard (org analytics) | ✅ | — | ✅ | — | — |
| Leads — visibility | All | — | All | Own + unassigned queue | All (read-only) |
| Leads — create / move / assign | ✅ | — | ✅ | Own only | — |
| Guests, Tasks | ✅ | — | ✅ | ✅ | ✅ |
| Health Records | ✅ | ✅ | — | — | — |
| Send WhatsApp / Email | ✅ | — | ✅ | Own leads only | — |
| Documents — medical / consent | ✅ | ✅ | — | — | — |
| Documents — operational | ✅ (upload) | — | ✅ (upload) | ✅ (upload) | Read-only |
| Packages & memberships | ✅ | — | ✅ | — | — |
| Referral codes | ✅ | — | ✅ | — | — |
| Reports — own | ✅ | — | ✅ | ✅ | — |
| Reports — all staff / Calls admin page | ✅ | — | ✅ | — | — |
| AI Audit (decision log) | ✅ | — | — | — | — |
| Users page (this feature) | ✅ | — | — | — | — |

Reception and Staff both work day-to-day on individual leads — the
difference is ownership scope: Reception can pick up unassigned leads and
message clients, while Staff sees everything read-only and has no messaging
or lead-assignment ability. Manager is Reception/Admin-scale oversight
(all leads, reports, packages) without Admin's user-management or AI-audit
access, and without Doctor's health-record access.

---

## The seed `admin` password

`doctor`/`manager`/`reception`/`staff` all seed with the shared demo password
`Password123!` (fine for a throwaway dev realm). The `admin` account is
different — it's the one login with full access, including this Users page
and AI Audit — so its password comes from `SEED_ADMIN_PASSWORD` in `.env`
instead of being hardcoded in the repo.

At startup, the `keycloak-realm-render` Compose job renders
`infra/keycloak/realm-export.template.json` — substituting
`${SEED_ADMIN_PASSWORD}` (and any other `${VAR}` placeholder) from `.env` —
into the `realm-export.json` that Keycloak actually imports. Set a real value
in `.env` before bringing up a fresh environment; `.env.example` ships the
placeholder `change-me-seed-admin-password`.

**This only affects a *fresh* realm import** — same caveat as everything else
in this file. On an already-running realm, changing `SEED_ADMIN_PASSWORD` and
redeploying does nothing until you also reset the live account's password:

```bash
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080 --realm master --user "$KEYCLOAK_ADMIN" --password "$KEYCLOAK_ADMIN_PASSWORD"

docker compose exec keycloak /opt/keycloak/bin/kcadm.sh set-password -r tre-wellness \
  --username admin --new-password 'the-new-password' --temporary
```

`--temporary` forces a password change at next login — drop it if you'd
rather set the final password directly. Either way, do this over the Users
page's own **reset password** action where possible (Method A above) — it's
the same underlying kcadm call, but scoped to a single account and logged
like any other admin action.

---

## Method A — the in-app Users page (recommended)

`/users` in the sidebar (Admin only, `users.manage` permission). Lets an
admin create, edit, disable, reset the password for, and delete staff
accounts without ever opening the Keycloak console.

- **New user**: first name, last name, email, username (auto-suggested from
  the email, editable), phone (optional, Indian format), and role. A
  temporary password is generated and shown **once** — copy it and hand it
  to the new staff member. They're required to set their own password on
  first login.
- **Edit**: change name, email, phone, or role. An admin cannot change their
  own role or disable their own account from this page (use the Keycloak
  account console for that, so nobody can accidentally lock themselves out).
  ⚠️ **Always rename staff through this page, never directly in the Keycloak
  Admin Console.** A name change here also re-syncs the `StaffProfile`
  row that every lead's "assigned to" display is resolved from live — a
  Keycloak-console-only rename skips that sync, so the old name keeps
  showing on every lead assigned to that person until someone notices and
  manually corrects the `StaffProfile` row (see the 2026-07-22 "Riya
  Reception" incident in [18 — Client roadmap](./18-client-roadmap.md)).
- **Search**: the box above the table filters by name, username, email,
  phone, or role as you type.
- **Phone number** isn't a Keycloak field — it's stored on the same
  `StaffProfile` row used for click-to-call and inbound call routing (see
  [13 — VoIP calls](./13-voip-calls.md)). Setting it here means the person
  doesn't have to visit Settings themselves before they can receive routed
  calls or be found in a lead-reassignment search. New accounts are created
  with `isOnline: false` regardless of whether a phone was set, so nobody
  becomes call-routing-eligible before they've actually logged in.
- **Reset password**: issues a fresh one-time temporary password, shown
  once the same way.
- **Disable / enable**: click the status badge — disabled accounts can't log
  in but aren't deleted, so history (leads, calls, notes) they created stays
  intact.
- **Delete**: permanently removes the Keycloak account. This does **not**
  delete or reassign any leads/calls/notes already attributed to that
  person — those keep showing the deleted user's name for historical
  record, they just won't have anyone able to log in as that identity
  anymore. Reassign their open leads to someone else *before* deleting.

### One-time setup this depends on

The Users page talks to Keycloak's Admin REST API as the `tre-crm` client
itself (client-credentials grant), not as the master-realm superadmin. This
needs the client's **service account** enabled with `realm-management` roles
`manage-users`, `view-users`, `query-users`.

`infra/keycloak/realm-export.template.json` now ships with this configured (a
`service-account-tre-crm` user with those `clientRoles`, and
`serviceAccountsEnabled: true` on the `tre-crm` client) — **but this only
applies on a fresh realm import.** Per the same caveat as the post-logout
redirect fix (see [05 — Auth](./05-auth-keycloak.md#️-import-realm-does-not-update-an-existing-realm)),
an **already-running** realm must be synced manually:

**Admin console (recommended, no downtime):**
1. Clients → `tre-crm` → *Capability config* → turn on **Service accounts roles** → Save.
2. A new tab, *Service accounts roles*, appears on the client → *Assign role*.
3. Filter by clients → `realm-management` → check `manage-users`, `view-users`, `query-users` → Assign.

**kcadm (scriptable):**
```bash
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080 --realm master --user "$KEYCLOAK_ADMIN" --password "$KEYCLOAK_ADMIN_PASSWORD"

CID=$(docker compose exec keycloak /opt/keycloak/bin/kcadm.sh get clients -r tre-wellness \
  -q clientId=tre-crm --fields id --format csv --noquotes | tr -d '\r' | tail -1)

docker compose exec keycloak /opt/keycloak/bin/kcadm.sh update clients/$CID -r tre-wellness \
  -s serviceAccountsEnabled=true

# Look up the service account's user id, then assign the three realm-management roles.
SAID=$(docker compose exec keycloak /opt/keycloak/bin/kcadm.sh get clients/$CID/service-account-user \
  -r tre-wellness --fields id --format csv --noquotes | tr -d '\r')

docker compose exec keycloak /opt/keycloak/bin/kcadm.sh add-roles -r tre-wellness \
  --uusername service-account-tre-crm --cclientid realm-management \
  --rolename manage-users --rolename view-users --rolename query-users
```

If this step hasn't been done yet, the Users page shows a clear error
("Keycloak client's service account isn't enabled") instead of a silent
failure — run the fix above and click Retry.

---

## Method B — Keycloak admin console (manual, always works)

No app changes needed — useful for one-off accounts or if the service
account above isn't set up yet.

1. Open the Keycloak admin console (`KEYCLOAK_PUBLIC_URL`, e.g.
   `http://harsha-pc-ubuntu:8080`) → sign in as the realm admin.
2. Switch to the **tre-wellness** realm (top-left realm selector).
3. **Users** → **Add user**.
   - Username, email, first/last name. Toggle **Email verified** on (skips
     Keycloak's own verification email flow, which isn't configured).
4. Save, then go to the **Credentials** tab → **Set password**. Toggle
   **Temporary** on so the user must change it at first login.
5. Go to the **Role mapping** tab → **Assign role** → filter by *Filter by
   realm roles* → pick exactly one of `crm-admin` / `crm-manager` /
   `crm-reception` / `crm-doctor` / `crm-staff`.

## Method C — kcadm CLI (scriptable, good for bulk onboarding)

```bash
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080 --realm master --user "$KEYCLOAK_ADMIN" --password "$KEYCLOAK_ADMIN_PASSWORD"

docker compose exec keycloak /opt/keycloak/bin/kcadm.sh create users -r tre-wellness \
  -s username=priya.reception -s email=priya@trewellness.in \
  -s firstName=Priya -s lastName=Reddy -s enabled=true -s emailVerified=true

docker compose exec keycloak /opt/keycloak/bin/kcadm.sh set-password -r tre-wellness \
  --username priya.reception --new-password 'TempPass123!' --temporary

docker compose exec keycloak /opt/keycloak/bin/kcadm.sh add-roles -r tre-wellness \
  --uusername priya.reception --rolename crm-reception
```

---

## Removing or disabling access

Prefer **disabling** over deleting when someone leaves temporarily (leave of
absence) — it revokes login immediately but keeps their history intact and
is reversible. Use **delete** only when the account should be permanently
gone (Method A's Delete action, or Keycloak console → Users → the user → the
**⋮** menu → Delete).

Either way, **reassign their open leads first** — deleting/disabling a
Keycloak account does not touch the CRM's `Enquiry.assignedToSub` field, so
leads stay pointed at an identity nobody can act on until someone
reassigns them (drag the card, or edit the lead's Owner).
