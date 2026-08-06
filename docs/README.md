# Trē Wellness CRM — Documentation

Engineering & operations docs for the CRM. Start here.

| Doc | What it covers |
| --- | --- |
| [01 — Architecture](./01-architecture.md) | System overview, request lifecycle, design philosophy |
| [02 — Services](./02-services.md) | Every container/service, what it does, ports, how to reach it |
| [03 — Docker & local dev](./03-docker.md) | Bringing the stack up/down, profiles, rebuilds, volumes |
| [04 — Database](./04-database.md) | Two-DB Postgres, Prisma, migrations, seed, the data model |
| [05 — Auth (Keycloak)](./05-auth-keycloak.md) | OIDC flow, realm, roles, test users, token notes |
| [06 — RBAC](./06-rbac.md) | Role → permission matrix and how it's enforced |
| [07 — Kanban & sales flow](./07-kanban-sales-flow.md) | Pipeline stages mapped to the Trē sales flow |
| [08 — Environment variables](./08-env-vars.md) | Every env var, grouped, with defaults |
| [09 — Debugging & commands](./09-debugging.md) | Cheat-sheet of commands for common problems |
| [10 — Roles & logins](./10-roles-and-logins.md) | **Usernames, passwords, and what each role can access** |
| [11 — Production release checklist](./11-production-release-checklist.md) | Pre-release gates: secrets, TLS, Keycloak hardening, smoke tests |
| [12 — Email integration](./12-email-integration.md) | Role-based mailboxes (SMTP/IMAP), guest-level threads, in-process inbound poller, auto-create lead on unmatched inbound |
| [13 — VoIP calls (Plivo)](./13-voip-calls.md) | Click-to-call, inbound routing to available reps, recordings + proxy playback |
| [14 — AI features](./14-ai-features.md) | Env-switchable LLM provider (Ollama default), call analysis, lead scoring, guest insights, conversation assist, background pipeline |
| [15 — AI/ML call map](./15-ai-ml-call-map.md) | **What runs where** — every AI/ML call site, local vs cloud, data flow diagram, how to switch providers |
| [16 — User management](./16-user-management.md) | Adding/editing/removing staff accounts — in-app Users page, Keycloak console, and kcadm CLI |
| [17 — WhatsApp integration](./17-whatsapp-integration.md) | Self-hosted WhatsApp via Evolution API — onboarding a number, the WhatsApp tab, multi-number support, ban-risk notes |
| [18 — Client roadmap](./18-client-roadmap.md) | Tracked punch-list from client meetings — what's done, in progress, or blocked on clarity |
| [19 — Server migration](./19-server-migration.md) | Cloning the whole deploy — DB, WhatsApp sessions, files, settings — onto a new machine |
| [22 — Immediate TODOs](./22-immediate-todos.md) | Not-yet-built tasks queued up for the next work session |
| [23 — Design system](./23-design-system.md) | Color/radius/spacing/component conventions — extend `components/ui`, don't style around it |

## TL;DR for a new engineer

```bash
cp .env.example .env
docker compose up -d postgres pgbouncer redis keycloak minio minio-init mailhog evolution-api
npm install && npm run prisma:generate && npm run prisma:deploy && npm run db:seed
npm run dev
```

Then open http://localhost:3000 and sign in as `reception` / `Password123!`.

## Service URLs (local)

| Service        | URL                       |
| -------------- | ------------------------- |
| CRM app        | http://localhost:3000     |
| Keycloak admin | http://localhost:8080     |
| MinIO console  | http://localhost:9001     |
| Mailhog UI     | http://localhost:8025     |
| Evolution API  | http://localhost:8090     |
| Postgres       | localhost:5432            |
| PgBouncer      | localhost:6432            |
| Redis          | localhost:6379            |
