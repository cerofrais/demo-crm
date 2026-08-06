# Ops scripts

Thin, dependency-free wrappers around `docker compose` and Prisma for building,
deploying and operating the Trē CRM stack. Every script accepts a **single
service**, **`infra`** (all backing services), or **`all`** (everything incl. the
app). Run them from anywhere — they cd to the repo root.

| Script | What it does |
| ------ | ------------ |
| `build.sh [all\|infra\|<service>] [--no-cache]` | Build the app image; pull image-based services |
| `deploy.sh [all\|infra\|app\|<service>] [--build] [--seed] [--no-migrate]` | Bring services up (with migrations) |
| `migrate.sh` | Apply Prisma migrations (host npm, else one-off container) |
| `seed.sh` | Load sample data (`prisma db seed`, host) |
| `down.sh [all\|<service>] [--volumes]` | Stop/remove containers (optionally wipe data) |
| `logs.sh [all\|<service>] [tailN]` | Follow logs |
| `status.sh` | Container state + app/DB/Redis health + URLs |
| `reset.sh [--yes]` | Wipe everything, recreate infra, migrate, seed |
| `backup-db.sh` | Dump all databases to `~/tre-backups`, prune anything older than 2 days |
| `restore-db.sh [file]` | **Destructive.** Restore a backup (defaults to the newest) |

Services: `postgres pgbouncer redis keycloak minio mailhog nextjs` (`app` is an
alias for `nextjs`).

## Common flows

```bash
# Local development (infra in Docker, app on host)
./scripts/deploy.sh infra --seed
npm run dev

# Full containerised stack (app included)
./scripts/deploy.sh all --build --seed

# Rebuild & redeploy just the app after code changes
./scripts/build.sh app && ./scripts/deploy.sh app

# Operate individual services
./scripts/deploy.sh keycloak
./scripts/logs.sh keycloak
./scripts/down.sh keycloak

# Inspect / tear down
./scripts/status.sh
./scripts/down.sh all            # keep data
./scripts/down.sh all --volumes  # delete data
./scripts/reset.sh               # full clean rebuild
```

## Notes

- The app container runs `prisma migrate deploy` on startup, so `deploy.sh all`
  and `deploy.sh app` migrate themselves; `deploy.sh infra` runs migrations for
  you.
- `seed.sh` runs on the host because the seed uses `tsx` (a dev dependency not
  shipped in the production image). Run `npm install` first.
- All scripts create `.env` from `.env.example` if it's missing — review the
  secrets before any real deployment.
