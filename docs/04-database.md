# 04 — Database

## One Postgres, two databases

A single `postgres` container hosts both:

- **`tre_crm`** — the application database (owned by the `tre_crm` role). The app
  reaches it through **PgBouncer** (`DATABASE_URL`, pooled). Migrations use a
  **direct** connection (`DIRECT_DATABASE_URL`, bypassing the pooler).
- **`keycloak`** — Keycloak's own store (owned by the `keycloak` role).

Both are created on first boot by
[`infra/postgres/init/01-create-databases.sh`](../infra/postgres/init/01-create-databases.sh),
which reads the `CRM_DB_*` / `KC_DB_*` env vars.

> This is a deliberate, agreed deviation from the tech spec (which uses two
> separate Postgres containers). One service is simpler to run and back up at
> Phase-1 scale.

## ORM & migrations (Prisma)

Schema: [`prisma/schema.prisma`](../prisma/schema.prisma).

```bash
npm run prisma:generate     # regenerate the typed client after schema edits
npm run prisma:migrate      # create + apply a new migration (dev)
npm run prisma:deploy       # apply pending migrations (CI/prod)
npm run prisma:studio       # browse data in a GUI
npm run db:seed             # load sample data
```

If you change `schema.prisma`, create a migration:

```bash
npx prisma migrate dev --name describe_your_change
```

An initial migration can be generated without a running DB via
`npm run migration:init` (uses `prisma migrate diff`).

## Data model (high level)

| Model            | Purpose |
| ---------------- | ------- |
| `Guest`          | A person. Unique by `phone`; powers returning-guest recognition. |
| `HealthProfile`  | 1:1 with Guest. **AES-256-GCM encrypted** medical screening blob. |
| `Enquiry`        | The pipeline ticket / Kanban card. Has a `stage`, `source`, owner. |
| `Note`           | Free-text remarks on an enquiry. |
| `Activity`       | Append-only audit log (no app DELETE). |
| `Message`        | WhatsApp/email/SMS timeline entries. |
| `Task`           | Reminders/follow-ups on an enquiry. |
| `Package`        | Programmes (residential/day/corporate). |
| `Membership`     | A guest's plan with credits & expiry. |
| `ReferralCode`   | Trackable codes with redemption counts. |
| `Document`       | Metadata for files stored in MinIO. |
| `UserPreference` | Per-user saved filters / column visibility (keyed by Keycloak `sub`). |

**Identity is not stored here.** Users/passwords live in Keycloak; we only keep
the Keycloak `sub` (and a cached display name) on rows that reference staff
(`assignedToSub`, `actorSub`, …).

## Returning-guest recognition

`findReturningGuest()` (`src/lib/enquiries.ts`) looks up by `phone` OR `email`
before any new guest is created. On a match, the new enquiry is flagged
`isReturningFlag` and the UI shows a "Returning guest" banner instead of
re-collecting details (goal #2, tech spec §6.1).

## Health-data encryption

`HealthProfile` stores `encryptedData` + `iv` + `authTag`. Encryption uses
`HEALTH_ENCRYPTION_KEY` (64-hex / 32 bytes) via `src/lib/crypto.ts`. Generate a
key with `openssl rand -hex 32`. Losing the key means the data is unrecoverable.
