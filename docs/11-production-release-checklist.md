# 11 — Production release checklist

Run through this before every production release. Tick each box; if a box can't
be ticked, the release does not ship. Items marked **🔒** are security gates —
never skip them to "fix later".

> The local dev defaults in `.env.example` are deliberately insecure and the
> stack runs over plain HTTP. **Production is HTTPS-only with every secret
> rotated.** This list exists to make sure none of the dev shortcuts leak into prod.

---

## 1. Code quality & CI

- [ ] `main` (or the release tag) is green in CI — `typecheck`, `lint`, `build` all pass.
- [ ] Working tree is clean; release is built from a tagged commit, not a dirty checkout.
- [ ] `npm run typecheck` passes locally.
- [ ] `npm run lint` passes locally.
- [ ] `npm run build` succeeds (runs `prisma generate && next build`, `output: standalone`).
- [ ] No `console.log` / debug code or `TODO`/`FIXME` blocking the release in changed files.
- [ ] `package-lock.json` committed and in sync (`npm ci` works clean).
- [ ] Dependency audit reviewed — `npm audit` has no unaddressed high/critical.

## 2. Secrets & environment 🔒

Every `change-me*` / placeholder value from `.env.example` **must** be rotated.
See [08 — Environment variables](./08-env-vars.md) for the full list.

- [ ] `NODE_ENV=production`.
- [ ] `APP_URL`, `NEXTAUTH_URL` set to the real public **https://** host.
- [ ] `NEXTAUTH_SECRET` generated fresh — `openssl rand -base64 32` (not the dev value).
- [ ] `SESSION_SECRET` generated fresh, distinct from `NEXTAUTH_SECRET`.
- [ ] `HEALTH_ENCRYPTION_KEY` generated once — `openssl rand -hex 32` — and **backed up in a secret manager**. Losing it = losing all encrypted health data. Never rotate without a re-encryption plan.
- [ ] DB passwords rotated: `POSTGRES_SUPER_PASSWORD`, `CRM_DB_PASSWORD`, `KC_DB_PASSWORD`.
- [ ] `KEYCLOAK_CLIENT_SECRET` rotated and matches the `tre-crm` client in Keycloak.
- [ ] `KEYCLOAK_ADMIN_PASSWORD` rotated (and bootstrap admin handled — see §4).
- [ ] `STORAGE_SECRET_KEY` / S3 credentials rotated.
- [ ] `ENQUIRY_WEBHOOK_SECRET`, `WHATSAPP_VERIFY_TOKEN` rotated.
- [ ] Secrets come from a secret manager / CI secrets, **not** a committed `.env`.
- [ ] `.env` is not in the image and not in git (confirm `.gitignore` + `.dockerignore`).

## 3. TLS, networking & headers 🔒

- [ ] App served over HTTPS behind a reverse proxy / load balancer (valid cert, auto-renew).
  - [ ] **Not started (2026-07-29).** The current internal/LAN deployment
        (`harsha-pc-ubuntu`) has no public domain, so a normal CA-issued cert
        (Let's Encrypt) isn't obtainable — plan is a **self-signed CA**
        instead: a one-time shell script generates a root CA + a server cert
        (SANs covering `harsha-pc-ubuntu` + `localhost`), fronted by a new
        nginx/reverse-proxy compose service that terminates TLS and forwards
        to `nextjs:3000`. The root CA then needs importing into each staff
        machine's browser/OS trust store once, or browsers will keep showing
        "not secure." **Open decision, asked but not yet answered:** cover
        just the CRM app, or also put Keycloak's own login page (port 8080 —
        where credentials are actually typed) behind TLS too?
- [ ] HTTP → HTTPS redirect in place; HSTS enabled at the proxy.
- [ ] Only the app (and Keycloak, if public) are internet-exposed. Postgres, PgBouncer, Redis, MinIO, Mailhog are **not** publicly reachable.
- [ ] Mailhog is **not** deployed to prod (dev SMTP sink only).
- [ ] **ngrok is NOT deployed to production.** Remove or omit the `ngrok` compose service (`profiles: ["dev"]`). Remove `NGROK_AUTHTOKEN` and `NGROK_DOMAIN` from the production env. `PLIVO_WEBHOOK_BASE_URL` must be set to the real production HTTPS URL — not an ngrok domain.
- [ ] Security headers verified in prod response (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` from `next.config.mjs`); `poweredByHeader` is off.
- [ ] Content-Security-Policy reviewed/tightened (tech spec §9.2) if in scope for this release.

## 4. Keycloak / auth hardening 🔒

- [ ] Keycloak runs in **production mode** (`start`, not `start-dev`) with `KC_HOSTNAME` set to the public auth URL and HTTPS configured.
- [ ] **Realm `sslRequired` is `external` (or `all`) — NOT `none`.** The `none` setting is a dev-over-Tailscale shortcut (see [05 — Auth](./05-auth-keycloak.md)); it must never reach prod. Verify on the running realm, not just the export.
- [ ] `KEYCLOAK_URL` / `KEYCLOAK_PUBLIC_URL` point at the real HTTPS host and the issuer matches what the browser and server both see.
- [ ] `tre-crm` client redirect URIs / web origins contain **only** the production host — no `localhost`, no `harsha-pc-ubuntu`, no dev IPs.
- [ ] `tre-crm` client secret rotated from the `change-me` placeholder and updated in `.env`.
- [ ] Bootstrap admin (`KC_BOOTSTRAP_ADMIN_*`) replaced with a real named admin account; the temporary bootstrap creds are removed/disabled.
- [ ] Seed/test users (`admin`, `doctor`, `manager`, `reception`, `staff` / `Password123!`) are **deleted or disabled** — they exist only for dev (see [10 — Roles & logins](./10-roles-and-logins.md)).
- [ ] MFA policy decided and configured for privileged roles (`crm-admin`, `crm-doctor`) per the Phase-1 plan.
- [ ] Realm session/token lifespans reviewed (access token, SSO idle/max) for prod.

## 5. Database & migrations

- [ ] All migrations committed and reviewed; `prisma migrate deploy` runs cleanly (the container entrypoint does this on boot via `DIRECT_DATABASE_URL`).
- [ ] Migrations are forward-only / backward-compatible enough to allow rollback of the app without breaking the DB.
- [ ] Runtime uses the **pooled** `DATABASE_URL` (PgBouncer); migrations use **direct** `DIRECT_DATABASE_URL`.
- [ ] **`db:seed` / `prisma/seed.ts` is NOT run against production** (it creates dev fixtures).
- [ ] Automated backups configured and a restore has been tested at least once.
- [ ] PgBouncer pool sizing reviewed against expected concurrency.

## 6. Object storage (MinIO / S3)

- [ ] `STORAGE_*` points at the production bucket (managed S3 or a hardened MinIO).
- [ ] Bucket is **private** (no anonymous read); files are served via presigned URLs.
- [ ] `STORAGE_PUBLIC_ENDPOINT` is the externally reachable HTTPS endpoint.
- [ ] Root/access credentials rotated.

## 7. Email & messaging providers

- [ ] `EMAIL_PROVIDER` set to a real provider (`smtp` with real host, or `resend` + `RESEND_API_KEY`) — **not** Mailhog.
- [ ] `EMAIL_FROM` is a deliverable, authenticated sender (SPF/DKIM/DMARC aligned).
- [ ] WhatsApp creds set if in scope (`WHATSAPP_TOKEN`, correct `WHATSAPP_API_URL`/provider).
- [ ] SMS/MFA OTP creds set if MFA-over-SMS is enabled (`MSG91_*`).
- [ ] Inbound IMAP sync configured only if that feature is live; otherwise left blank.

## 8. Observability & operations

- [ ] `LOG_LEVEL` set appropriately (`info` or `warn`); no `debug`/`trace` in prod.
- [ ] Logs shipped/retained somewhere queryable (pino JSON output).
- [ ] Error tracking / alerting wired up for app and Keycloak.
- [ ] Health checks green for every service (Postgres, Redis, MinIO, Keycloak) before flipping traffic.
- [ ] `TZ` is correct for the deployment (`Asia/Kolkata`).
- [ ] Rate limits (`RATE_LIMIT_AUTHED_PER_MIN`, `RATE_LIMIT_ANON_PER_MIN`) tuned for prod.

## 9. Build & deploy

- [ ] Production image built from the release commit (`infra/docker/Dockerfile`, standalone runner, non-root `nextjs` user).
- [ ] Image tagged/pinned and pushed to the registry; deploy references the digest/tag, not `latest`.
- [ ] Compose/orchestration overrides internal hostnames correctly (app reaches services by name, browser-facing URLs use the public host).
- [ ] Entrypoint migration step (`migrate deploy`) verified against a staging DB first.

## 10. Post-deploy smoke test

- [ ] App loads over HTTPS at the public URL.
- [ ] Login via Keycloak works end-to-end (redirect → callback → session), with a **real** user, not a seed account.
- [ ] Role gating works: a non-admin is bounced from admin-only routes; an admin can reach them.
- [ ] Logout (federated) terminates the Keycloak SSO session and returns to `/login`.
- [ ] Create/read a lead through the kanban flow.
- [ ] File upload + presigned download works against prod storage.
- [ ] A test email actually sends and is delivered.
- [ ] Enquiry webhook accepts a correctly-signed payload and rejects a bad signature.

## 11. Rollback plan

- [ ] Previous image tag known and re-deployable.
- [ ] Rollback steps documented (revert app image; DB migrations are backward-compatible or have a down path).
- [ ] On-call / owner identified for the release window.
- [ ] Decision criteria written down for *when* to roll back (error rate, failed logins, 5xx threshold).

## 12. AI/ML production readiness 🔒

See [15 — AI/ML call map](./15-ai-ml-call-map.md) for exactly what runs
where today. As deployed in dev, the LLM (Ollama/gemma4) and transcription
(whisper) both run **locally** on the deploy box — no guest data reaches a
third-party AI API. That changes the moment `AI_BASE_URL` /
`AI_TRANSCRIBE_BASE_URL` point at a cloud provider, so the checklist below
splits into "either way" and "if going cloud."

### Either way (local or cloud LLM)

- [ ] Decision made and documented: **local (self-hosted) vs cloud provider**
      for the LLM and for transcription — these can differ (e.g. local LLM +
      cloud transcription). Don't leave this as an accidental default.
- [ ] `AI_MODEL` is pinned to a specific version/tag, not a floating `latest`
      — model updates should be a deliberate, tested change, not something
      that silently changes scoring/coaching behavior on a host restart.
- [ ] AI feature flags (`AI_FEATURE_CALL_ANALYSIS`, `AI_FEATURE_LEAD_SCORING`,
      `AI_FEATURE_GUEST_INSIGHTS`, `AI_FEATURE_ASSIST`) reviewed — enable only
      what's been validated for this release; toggle individually if issues
      surface post-launch (no rebuild needed, just a restart).
- [ ] `AI_PIPELINE_INTERVAL_SEC` and the per-tick batch limits (5 calls / 8
      leads / 5 guests, hardcoded in `src/lib/ai/pipeline.ts`) reviewed
      against real call/lead volume — a busy day's backlog should clear
      within a reasonable window, not queue for hours.
- [ ] Output quality spot-checked against real (not just seeded) calls and
      leads before the pipeline result is trusted for business decisions —
      there is no automated eval suite for AI output quality yet.
- [ ] Monitoring/alerting on AI pipeline health: tick success/failure rate,
      "AI chat returned an empty response" errors (see the thinking-model
      note in [14 — AI features](./14-ai-features.md)), and stuck/growing
      backlogs (`aiScoredAt IS NULL` / `aiAnalyzedAt IS NULL` counts).
- [ ] Runbook exists for "the AI pipeline is silently failing" — logs to
      check (`docker logs <app> | grep 'ai pipeline'`), how to force a tick
      (`POST /api/ai/pipeline`), how to disable a single feature without a
      full rollback.
- [ ] Decision made on the currently-untested-in-prod ASR alternative
      (`indic-asr` / AI4Bharat IndicConformer, no English support) — leave it
      off (`AI_TRANSCRIBE_BASE_URL` pointed at `whisper`) unless it's been
      validated against your actual call-language mix.

### If self-hosting locally (current dev configuration)

- [ ] **Ollama is a host-level systemd service, not a container** — it is
      *outside* `docker compose` and will not restart/redeploy with the rest
      of the stack. If the deploy box is rebuilt or replaced, Ollama +
      the model pull (`ollama pull <model>`) must be reprovisioned manually.
      Document this as an explicit step in the deploy runbook, or move it
      into compose/IaC before relying on it in production.
- [ ] **GPU capacity checked, not assumed.** On the current box (RTX 4070
      SUPER, 12GB VRAM) `gemma4:latest` alone uses ~9.5GB, leaving ~2GB free —
      there is no headroom to also run a GPU-accelerated transcription model
      without risking OOM. If production needs both LLM and ASR on GPU
      simultaneously, size the GPU (or the model) for that *before* launch,
      not after a crash. See §"GPU strategy" discussion in project history —
      CPU-based `whisper`/`indic-asr` alongside a GPU LLM is the tested,
      working split.
- [ ] `nvidia-container-toolkit` status confirmed matches expectations — it
      is **not installed** in the current dev environment, so `whisper` and
      `indic-asr` run on CPU only. If GPU-accelerated ASR is planned for
      prod, this needs installing and the compose services need
      `runtime: nvidia` / CUDA-enabled images.
- [ ] Model cache volumes (`whispermodels`, `indicasrmodels`, and Ollama's own
      model store) are on durable storage and included in backup/DR planning
      — or explicitly accepted as "re-downloadable, not backed up" with the
      redownload time factored into recovery time objectives.
- [ ] `HF_TOKEN` (only needed if `indic-asr` is in use) rotated out of any
      shared/dev value and stored in a secret manager, not a committed `.env`.
- [ ] Compute sizing reviewed: local inference means the deploy box's CPU/GPU
      is a shared resource between the app, the DB, and every AI feature —
      load-test the pipeline running alongside normal app traffic, not in
      isolation.

### If using a cloud AI provider instead 🔒

- [ ] **Data processing / compliance review completed** before enabling —
      guest health profile content (decrypted), call transcripts, and email
      bodies would be sent to the third-party provider (see
      [15 — AI/ML call map §4](./15-ai-ml-call-map.md#4-switching-to-a-cloud-provider)).
      Confirm this is acceptable under your DPDP/HIPAA-equivalent obligations
      and that a data processing agreement is in place with the provider.
- [ ] `AI_API_KEY` / `AI_TRANSCRIBE_API_KEY` stored in a secret manager, not
      `.env`; scoped/restricted per provider best practice.
- [ ] Cost controls in place — no budget guardrail or spend cap exists in the
      pipeline code today (`src/lib/ai/pipeline.ts` limits *volume per tick*,
      not *cost*). A stuck loop or traffic spike against a paid API is a
      real bill risk; set provider-side spend alerts/limits.
- [ ] Provider outage/rate-limit handling verified — pipeline steps already
      catch and log per-item errors without crashing (see
      `runAiPipeline()`), but confirm behavior under sustained 429s/5xx from
      the provider rather than the occasional local-model hiccup.
- [ ] Data residency confirmed if guest data must legally stay in India —
      most global LLM APIs do not guarantee in-region processing by default.

