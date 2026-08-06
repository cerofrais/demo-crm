# Trē Wellness CRM

A modern CRM for the sales & management teams of [Trē Wellness](https://trewellness.in) —
lead capture, a drag-and-drop sales pipeline, returning-guest recognition,
guest & (encrypted) health records, documents, referrals and messaging.

Built on the Phase-1 stack from the technical specification: **Next.js 14 (App
Router) · TypeScript · Prisma · PostgreSQL · Redis · Keycloak · MinIO**, all
orchestrated with Docker Compose and driven entirely from environment variables.

> Theme: Trē brand palette — olive green `#2d6a4f`, deep green `#1b4332`, ink
> `#1b2e22`, light green `#f0f7f3`, white & neutral greys.

---

## Quick start

```bash
# 1. Configure
cp .env.example .env          # then edit secrets (see docs/08-env-vars.md)

# 2. Bring up the infrastructure (Postgres+2 DBs, Redis, Keycloak, MinIO, Mailhog)
docker compose up -d postgres pgbouncer redis keycloak minio minio-init mailhog

# 3. Install app deps & set up the database
npm install
npm run prisma:generate
npm run prisma:deploy         # apply migrations
npm run db:seed               # sample leads across the pipeline

# 4. Run the app (on the host; talks to the dockerised services)
npm run dev                   # http://localhost:3000
```

Log in with any seeded Keycloak user (password `Password123!`):

| User        | Role         | Lands on          |
| ----------- | ------------ | ----------------- |
| `admin`     | Administrator | Dashboard        |
| `manager`   | Manager       | Dashboard        |
| `doctor`    | Doctor        | Health Records   |
| `reception` | Front Office  | Leads (Kanban)   |
| `staff`     | Staff         | Leads (read-only)|

To run the **whole** thing (app included) in Docker:
`docker compose --profile app up -d --build`.

### Or use the ops scripts

```bash
./scripts/deploy.sh infra --seed   # backing services + migrate + seed (then `npm run dev`)
./scripts/deploy.sh all --build     # full containerised stack (app included)
./scripts/build.sh app              # rebuild just the app image
./scripts/status.sh                 # container + health overview
./scripts/down.sh all               # stop (add --volumes to wipe data)
```

Every script takes a single service, `infra`, or `all`. See
[scripts/README.md](./scripts/README.md).

---

## What's built

- ✅ **Docker Compose** stack — one Postgres service hosting **two** databases
  (CRM + Keycloak), PgBouncer pooling, Redis, Keycloak (realm + roles + users
  pre-seeded), MinIO, Mailhog.
- ✅ **Keycloak OIDC auth** + **RBAC** (5 roles) enforced in middleware and APIs.
- ✅ **Prisma schema** for the full domain + migrations + demo seed data.
- ✅ **Leads workspace** — List + Kanban (drag-to-assign), filters & search,
  lead detail drawer (details / remarks / conversation / calls / AI assist /
  documents / activity), CSV export, tag library, needs-attention highlight.
- ✅ **Returning-guest recognition** by phone/email.
- ✅ **Email conversations** — role-based mailboxes (SMTP/IMAP), threaded
  inbound poller, auto-create lead from unknown senders.
- ✅ **VoIP calls (Plivo)** — click-to-call (rep-first bridge), inbound routing
  to the least-busy online rep, recordings playable in-app.
- ✅ **AI layer (env-switchable provider; local Ollama by default)** — call
  quality scoring + coaching, lead conversion scoring on cards, guest
  return-likelihood + next-programme recommendations with auto outreach
  tasks, and an AI Assist tab that drafts replies and next actions.
- ✅ **Encrypted health records** (AES-256-GCM), doctor/admin gated.
- ✅ **Documents (MinIO presigned)**, **packages & referral codes (QR)**,
  **tasks/reminders (2-2-2 cadence)**, **performance reports**.
- ✅ **Public webhook** (`/api/webhooks/enquiry-form`) for multi-source onboarding.
- ✅ **Admin dashboard** + **reports** (source × stage matrix).
- ✅ Structured logging, env validation, standard API envelope.

See [`docs/`](./docs) for everything: architecture, each service, the database,
auth, RBAC, the Kanban/sales flow mapping, env vars and debugging commands.

## Repository layout

```
.
├── src/
│   ├── app/                 # Next.js App Router (pages + /api routes)
│   ├── components/          # UI primitives + feature components
│   ├── lib/                 # auth, rbac, prisma, env, logging, domain logic
│   ├── types/               # type augmentation (next-auth)
│   └── middleware.ts        # route-level auth + role gating
├── prisma/                  # schema, migrations, seed
├── infra/                   # docker, postgres init, pgbouncer, keycloak realm
├── docs/                    # service & operations documentation
├── docker-compose.yml
└── .env.example
```

## Tech-spec alignment

This implements **Phase 1** of `TreWellness_CRM_TechSpec_v3`. Two intentional,
agreed deviations: a **single Postgres service with two databases** (the spec
shows two containers) and **Mailhog** for local email (Postal/Resend swap in via
env). The AI layer ships ahead of spec — self-hosted via Ollama by default,
switchable to OpenAI/Anthropic per env (see `docs/14-ai-features.md`). Other
optional services (BullMQ, reverse proxy, PostHog, GlitchTip, ClamAV) are
deferred per the spec.
