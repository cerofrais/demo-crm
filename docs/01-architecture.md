# 01 — Architecture

## Design philosophy

Phase 1 is intentionally simple. At Trē's current scale (small team, one
location, low concurrency) the priority is fast delivery of working software, not
infrastructure complexity. The stack is proven, boring technology one engineer
can run locally and debug. Heavier services (job queues, reverse proxy,
analytics, error dashboards) are deferred until there's a concrete reason —
they're listed in the tech spec's Optional Services section.

## System overview

```
            Browser / WhatsApp / Website form
                          │  HTTPS
                          ▼
        ┌──────────────────────────────────────┐
        │   Next.js 14 (App Router)             │
        │   • SSR pages + /api route handlers   │
        │   • NextAuth (Keycloak OIDC)          │
        │   • middleware: auth + RBAC gating    │
        └───┬───────────┬──────────────┬────────┘
            │           │              │
     ┌──────▼───┐  ┌────▼────┐   ┌─────▼─────┐
     │ PgBouncer│  │ Redis 7 │   │  MinIO    │
     │   ↓      │  │ session │   │ files &   │
     │ Postgres │  │ + cache │   │ documents │
     │ 16       │  └─────────┘   └───────────┘
     │ ├ tre_crm│
     │ └ keycloak◄──────── Keycloak (identity)
     └──────────┘         (its own DB on the same Postgres)

     Mailhog (dev SMTP sink)  ·  WATI/SMTP/MSG91 (external, prod)
```

A **single Postgres service** hosts two logical databases: `tre_crm` (the app,
via Prisma → PgBouncer) and `keycloak` (Keycloak's own store). See
[04 — Database](./04-database.md).

## Request lifecycle

1. Browser hits the Next.js app.
2. `src/middleware.ts` checks for a valid session (NextAuth JWT backed by
   Keycloak). No/expired token → redirect to `/login` → Keycloak.
3. Role-gated route prefixes (e.g. `/dashboard`) are checked against the roles
   baked into the JWT — **no DB lookup** (tech spec §8).
4. API route handlers validate input with **Zod**, enforce the relevant
   permission, and return the standard envelope (`{ data }` / `{ error }`).
5. DB access is always through **Prisma** → **PgBouncer** (transaction pooling).
   No raw SQL with user input.
6. External calls (WhatsApp/email) are awaited inline in Phase 1 (no queue).

## Code organisation

- `src/app` — routes. `(app)/` is the authenticated shell (sidebar layout);
  `api/` are the route handlers; `login/` is public.
- `src/lib` — the brains: `auth.ts`, `rbac.ts`, `prisma.ts`, `env.ts`,
  `logger.ts`, `crypto.ts`, `kanban.ts`, plus domain logic (`enquiries.ts`,
  `enquiry-service.ts`).
- `src/components` — `ui/` primitives (brand-themed, shadcn-style), `app/` shell
  pieces, and feature folders (`leads/`, `guests/`).

## Key cross-cutting decisions

- **Env-driven everything.** Swapping a provider (S3 for MinIO, Resend for SMTP,
  Meta for WATI) means editing `.env`, not code. See [08](./08-env-vars.md).
- **Audit by default.** Every meaningful action writes an `Activity` row; the app
  DB role has no DELETE on it (DPDP audit trail).
- **Health data encrypted at the app layer** (AES-256-GCM) before it touches
  Postgres — see `src/lib/crypto.ts`.
