# 08 — Environment variables

Everything is configured via `.env` (copied from `.env.example`). The app reads
and validates them through [`src/lib/env.ts`](../src/lib/env.ts) (Zod); Docker
Compose passes the same file to the services. Defaults keep `next build` working
without secrets — but you **must** set real values before running.

## Must-change before first run

| Var | Why |
| --- | --- |
| `POSTGRES_SUPER_PASSWORD`, `CRM_DB_PASSWORD`, `KC_DB_PASSWORD` | DB credentials |
| `KEYCLOAK_CLIENT_SECRET` | Must match the `tre-crm` client secret in Keycloak |
| `KEYCLOAK_ADMIN_PASSWORD` | Keycloak admin console login |
| `SEED_ADMIN_PASSWORD` | Password for the CRM's own `admin` user on a fresh realm import — see [16 — User management](./16-user-management.md) |
| `NEXTAUTH_SECRET` | Session signing — `openssl rand -base64 32` |
| `HEALTH_ENCRYPTION_KEY` | 32-byte hex — `openssl rand -hex 32` (lose it = lose health data) |
| `STORAGE_SECRET_KEY` | MinIO root password |
| `ENQUIRY_WEBHOOK_SECRET` | HMAC secret for the public enquiry webhook |
| `WA_DB_PASSWORD`, `EVOLUTION_API_KEY`, `WHATSAPP_WEBHOOK_SECRET` | WhatsApp (Evolution API) — see [17 — WhatsApp integration](./17-whatsapp-integration.md) |

## Reference (grouped)

### General
`NODE_ENV`, `APP_NAME`, `APP_URL`, `TZ`, `LOG_LEVEL`

### Postgres (single service, three DBs)
`POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_SUPER_USER`, `POSTGRES_SUPER_PASSWORD`,
`CRM_DB_NAME`, `CRM_DB_USER`, `CRM_DB_PASSWORD`,
`KC_DB_NAME`, `KC_DB_USER`, `KC_DB_PASSWORD`,
`WA_DB_NAME`, `WA_DB_USER`, `WA_DB_PASSWORD` (Evolution API / WhatsApp)

### Connection strings (Prisma)
- `DATABASE_URL` — **pooled** via PgBouncer, used at runtime
- `DIRECT_DATABASE_URL` — **direct** to Postgres, used by `prisma migrate`

### Redis
`REDIS_URL`

### Keycloak / NextAuth
`KEYCLOAK_URL`, `KEYCLOAK_PUBLIC_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`,
`KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD`,
`SEED_ADMIN_PASSWORD`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `SESSION_SECRET`

`SEED_ADMIN_PASSWORD` is only read by the `keycloak-realm-render` Compose job
(not by the Next.js app) — it renders `infra/keycloak/realm-export.template.json`
into the file Keycloak actually imports. Like the rest of the realm import, it
only takes effect on a **fresh** realm; an already-running realm needs a manual
`kcadm` password reset, same as any other post-deploy Keycloak change.

### Health encryption
`HEALTH_ENCRYPTION_KEY`

### Object storage (MinIO / S3)
`STORAGE_ENDPOINT`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_REGION`,
`STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`,
`STORAGE_FORCE_PATH_STYLE`

`STORAGE_PUBLIC_ENDPOINT` is signed into presigned upload/download URLs
handed to the **browser** — it must be a host the browser can actually
reach, same reasoning as `KEYCLOAK_PUBLIC_URL`. On a multi-host deploy
(app reached at a LAN hostname, not `localhost`), `docker-compose.yml`'s
`nextjs` service overrides this to that hostname; if attaching/uploading
a document fails with a generic network error but the request never
reaches the server (no `Document` row, nothing in server logs), this is
the first thing to check.

### Email
`EMAIL_PROVIDER` (`smtp|resend`), `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `IMAP_*`, `RESEND_API_KEY`

### WhatsApp / SMS — see [17 — WhatsApp integration](./17-whatsapp-integration.md)
`EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `WHATSAPP_WEBHOOK_SECRET`,
`WHATSAPP_VERIFY_TOKEN` (reserved for a future official Meta Cloud API mode),
`MSG91_API_KEY`, `MSG91_SENDER_ID`, `MSG91_TEMPLATE_ID_OTP`

### Webhooks & tuning
`ENQUIRY_WEBHOOK_SECRET`, `RATE_LIMIT_AUTHED_PER_MIN`, `RATE_LIMIT_ANON_PER_MIN`,
`AUTO_ASSIGN_STRATEGY` (`round_robin|unassigned`)

`NEXT_PUBLIC_LEADS_AUTOREFRESH_INTERVAL_SEC` — how often the Leads board
polls for new/changed tickets (default 30; `0` disables it and hides the
toolbar toggle). Paused automatically whenever a lead's drawer is open, and
reps can pause/resume it themselves. **This one is different from every
other var on this page**: `NEXT_PUBLIC_*` is inlined into the browser bundle
at *build* time, not read at container startup — in Docker it only takes
effect via `docker-compose.yml`'s `nextjs.build.args`, so changing it needs
`docker compose build nextjs` (a rebuild), not just a restart. `npm run dev`
picks it up normally since there's no separate build step.

### VoIP (Plivo) — see [13 — VoIP calls](./13-voip-calls.md)
`PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_PHONE_NUMBER`,
`PLIVO_WEBHOOK_BASE_URL` (public HTTPS; falls back to `NEXTAUTH_URL`)

### AI — see [14 — AI features](./14-ai-features.md)
`AI_ENABLED`, `AI_PROVIDER`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`,
`AI_TEMPERATURE`, `AI_MAX_TOKENS` (2048+ for thinking models), `AI_TIMEOUT_MS`,
`AI_TRANSCRIBE_BASE_URL`, `AI_TRANSCRIBE_API_KEY`, `AI_TRANSCRIBE_MODEL`,
`AI_PIPELINE_ENABLED`, `AI_PIPELINE_INTERVAL_SEC`,
`AI_FEATURE_CALL_ANALYSIS`, `AI_FEATURE_LEAD_SCORING`,
`AI_FEATURE_GUEST_INSIGHTS`, `AI_FEATURE_ASSIST` (per-feature kill switches)

## Switching providers (no code changes)

| Goal | Change |
| ---- | ------ |
| Use AWS S3 instead of MinIO | Point `STORAGE_ENDPOINT` + keys/bucket at S3 |
| Use Resend instead of SMTP  | `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` |
| Add/remove a WhatsApp number | `/whatsapp-numbers` admin page — no env vars per number |
| Use managed Postgres        | Point `DATABASE_URL` + `DIRECT_DATABASE_URL` at it |
| Use OpenAI instead of Ollama | `AI_BASE_URL=https://api.openai.com/v1` + `AI_API_KEY` + `AI_MODEL` |
| Use Anthropic instead of Ollama | `AI_BASE_URL=https://api.anthropic.com/v1` + `AI_API_KEY` + `AI_MODEL` |
