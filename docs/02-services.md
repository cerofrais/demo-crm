# 02 — Services

Every service in `docker-compose.yml`, what it's for, and how to reach it.

| Service       | Image                         | Host port(s) | Purpose |
| ------------- | ----------------------------- | ------------ | ------- |
| `postgres`    | `postgres:16-alpine`          | 5432         | One DB server, **three** databases: `tre_crm` + `keycloak` + `whatsapp` |
| `pgbouncer`   | `bitnami/pgbouncer`           | 6432         | Transaction pooling in front of `tre_crm`; the app connects here |
| `redis`       | `redis:7-alpine`              | 6379         | Sessions, JWKS cache, rate-limit counters (db 0); Evolution API cache lives on db 1 |
| `keycloak`    | `quay.io/keycloak/keycloak:26`| 8080         | Identity provider; realm `tre-wellness` auto-imported |
| `minio`       | `minio/minio`                 | 9000 / 9001  | S3-compatible object storage (9001 = console) |
| `minio-init`  | `minio/mc`                    | —            | One-shot job: creates the `tre-crm-files` bucket |
| `mailhog`     | `mailhog/mailhog`             | 1025 / 8025  | Dev SMTP sink (1025 = SMTP, 8025 = web UI) |
| `evolution-api` | `evoapicloud/evolution-api:v2.3.7` | 8090   | Self-hosted WhatsApp gateway (Baileys) — see [17](./17-whatsapp-integration.md) |
| `nextjs`      | built from `infra/docker`     | 3000         | The CRM app (profile `app`; usually run on host in dev) |

All services share the `tre` bridge network and read secrets from `.env`.

## Reaching each service

| Service        | From host                  | From inside the network |
| -------------- | -------------------------- | ----------------------- |
| CRM app        | http://localhost:3000      | `http://nextjs:3000`    |
| Keycloak       | http://localhost:8080      | `http://keycloak:8080`  |
| Postgres       | `localhost:5432`           | `postgres:5432`         |
| PgBouncer      | `localhost:6432`           | `pgbouncer:6432`        |
| Redis          | `localhost:6379`           | `redis:6379`            |
| MinIO API      | http://localhost:9000      | `http://minio:9000`     |
| MinIO console  | http://localhost:9001      | —                       |
| Mailhog UI     | http://localhost:8025      | —                       |
| Evolution API  | http://localhost:8090      | `http://evolution-api:8080` |

> **Why two hostnames matter for Keycloak:** tokens embed an *issuer* URL. In dev
> the app runs on the host and uses `localhost:8080` for both browser redirects
> and server calls, so issuers match. See [05 — Auth](./05-auth-keycloak.md) for
> the containerised-app caveat.

## Production swaps (env only)

| Concern   | Dev default        | Prod alternative              | Env to change |
| --------- | ------------------ | ----------------------------- | ------------- |
| Storage   | MinIO              | AWS S3 / Cloudflare R2        | `STORAGE_*`   |
| Email     | Mailhog (SMTP)     | Postal (SMTP) / Resend        | `EMAIL_*`     |
| WhatsApp  | Evolution API (Baileys, self-hosted) | Evolution API in official Meta Cloud API mode | per-number, set from the `/whatsapp-numbers` admin page |
| Database  | Postgres container | Supabase / Neon               | `DATABASE_URL`, `DIRECT_DATABASE_URL` |

## Optional services (not installed — add when needed)

BullMQ (queues), Caddy/Nginx (reverse proxy + TLS), PostHog (analytics),
GlitchTip/Sentry (errors), ClamAV (virus scan), OpenAI (AI drafts). Each is
documented in the tech spec §12.
