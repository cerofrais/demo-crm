# 05 — Authentication (Keycloak)

Keycloak is the single identity provider. **No passwords or user records live in
the CRM database** — all identity is in Keycloak. The CRM is an OIDC confidential
client; roles come from the access token.

## How it fits together

- **NextAuth (Auth.js)** with the Keycloak provider handles the OIDC
  Authorization Code flow (`src/lib/auth.ts`).
- On sign-in we decode the Keycloak access token's `realm_access.roles` and map
  them to CRM roles (`src/lib/rbac.ts`), stored in the session JWT.
- `src/middleware.ts` requires a session on all app routes and gates
  admin-only prefixes by role — no DB lookup.

## Realm, client, roles

Auto-imported from
[`infra/keycloak/realm-export.template.json`](../infra/keycloak/realm-export.template.json)
(rendered to `realm-export.json` by the `keycloak-realm-render` Compose job,
substituting `${SEED_ADMIN_PASSWORD}` and other `${VAR}` placeholders from
`.env` — see [08 — Environment variables](./08-env-vars.md)):

- **Realm:** `tre-wellness`
- **Client:** `tre-crm` (confidential, standard flow). Redirect URI
  `http://localhost:3000/api/auth/callback/keycloak`.
- **Realm roles:** `crm-admin`, `crm-doctor`, `crm-manager`, `crm-reception`,
  `crm-staff` → mapped to `ADMIN / DOCTOR / MANAGER / RECEPTION / STAFF`.

## Test users

`doctor`/`manager`/`reception`/`staff` all have password **`Password123!`**.
`admin`'s password comes from `SEED_ADMIN_PASSWORD` in `.env` instead of being
hardcoded, since it's the one account with full access (Users page, AI Audit) —
change it in `.env.example`'s `change-me-seed-admin-password` before a fresh
deploy. Only applies on first realm import — see the caveat below.

| Username    | Email             | Role          | Password |
| ----------- | ----------------- | ------------- | -------- |
| `admin`     | admin@tre.test    | crm-admin     | `SEED_ADMIN_PASSWORD` (.env) |
| `doctor`    | doctor@tre.test   | crm-doctor    | `Password123!` |
| `manager`   | manager@tre.test  | crm-manager   | `Password123!` |
| `reception` | reception@tre.test| crm-reception | `Password123!` |
| `staff`     | staff@tre.test    | crm-staff     | `Password123!` |

## Keycloak admin console

http://localhost:8080 → log in with `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`
from `.env`. Manage real staff users, roles and MFA here.

## Important: client secret must match

The realm export ships a placeholder client secret
(`change-me-keycloak-client-secret`) that **must equal** `KEYCLOAK_CLIENT_SECRET`
in `.env`. For production, rotate it: in the console go to *Clients → tre-crm →
Credentials → Regenerate*, then update `.env` and restart the app.

## The issuer / hostname caveat

OIDC tokens embed an *issuer* URL that must match between where the browser is
redirected and where the server validates. We control it with:

- `KEYCLOAK_PUBLIC_URL` → browser-facing issuer (default `http://localhost:8080`)
- `KEYCLOAK_URL` → internal server-to-server URL

**Dev (recommended):** run the app on the host (`npm run dev`). Both browser and
server use `localhost:8080`, so issuers match — it just works.

**Fully containerised app:** the app container can't reach `localhost:8080`. Give
Keycloak a stable hostname both sides can resolve (e.g. set `KC_HOSTNAME` and a
shared DNS name / reverse proxy), and point `KEYCLOAK_URL` and
`KEYCLOAK_PUBLIC_URL` at it. This is the "add a reverse proxy" step from the tech
spec's optional services.

## ⚠️ `--import-realm` does NOT update an existing realm

This bites everyone once. Keycloak starts with `start-dev --import-realm`, which
imports `realm-export.json` **only if the realm doesn't already exist**. After the
first boot, the realm lives in the `keycloak` database — and **every later
redeploy skips the import**. Editing `realm-export.template.json` (or
`SEED_ADMIN_PASSWORD` in `.env`) and rebuilding/redeploying the app therefore
has **no effect** on the running realm — including rotating the seed admin's
password, which needs a manual `kcadm set-password` on a live deploy (see
[16 — User management](./16-user-management.md)).

To apply realm/client changes to a *running* Keycloak, do one of:

1. **Admin console (recommended, no downtime):** Clients → `tre-crm` → change the
   setting → Save (Save invalidates the cache immediately).
2. **kcadm:**
   ```bash
   docker compose exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
     --server http://localhost:8080 --realm master --user "$KEYCLOAK_ADMIN" --password "$KEYCLOAK_ADMIN_PASSWORD"
   CID=$(docker compose exec keycloak /opt/keycloak/bin/kcadm.sh get clients -r tre-wellness \
     -q clientId=tre-crm --fields id --format csv --noquotes | tr -d '\r' | tail -1)
   docker compose exec keycloak /opt/keycloak/bin/kcadm.sh update clients/$CID -r tre-wellness -s '<field>=<value>'
   ```
3. **Force a clean re-import** (makes `realm-export.template.json` + current
   `.env` values authoritative again, but destroys any users/changes made in
   Keycloak since):
   ```bash
   docker compose exec postgres psql -U postgres -c 'DROP DATABASE keycloak;'
   docker compose exec postgres psql -U postgres -c 'CREATE DATABASE keycloak OWNER keycloak;'
   docker compose up -d keycloak-realm-render keycloak   # re-renders + re-imports on next boot
   ```

### Logout → "Invalid redirect uri"

If logout shows Keycloak's "We are sorry… Invalid redirect uri", the client's
**Valid post logout redirect URIs** doesn't include the app's `/login` URL. Set
that field to `+` (mirrors the Valid redirect URIs) — or list the exact hosts —
via one of the methods above. `realm-export.json` ships with `+` for fresh
installs, but existing realms must be updated with method 1 or 2.

## MFA (Phase 1 plan)

TOTP is intended for `crm-admin` and `crm-doctor`, enforced at the realm level,
with SMS OTP fallback via the MSG91 plugin (`MSG91_*`). Enable in the realm's
*Authentication* settings when going live.
