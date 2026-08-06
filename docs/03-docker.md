# 03 — Docker & local development

> **Shortcut:** the [`scripts/`](../scripts) wrappers cover most of this —
> `scripts/deploy.sh infra --seed`, `scripts/build.sh app`, `scripts/status.sh`,
> `scripts/logs.sh <svc>`, `scripts/down.sh all`. See [scripts/README.md](../scripts/README.md).
> The raw `docker compose` commands below are the underlying equivalents.

## Prerequisites

- Docker + Docker Compose v2 (`docker compose version`)
- Node.js ≥ 20 and npm (for running the app on the host in dev)

## Bring the stack up

Infrastructure only (recommended for dev — run the app with `npm run dev`):

```bash
docker compose up -d postgres pgbouncer redis keycloak minio minio-init mailhog evolution-api
```

Everything including the app, containerised:

```bash
docker compose --profile app up -d --build
```

The `nextjs` service is behind the `app` profile so the default
`docker compose up` brings up only the backing services.

## Common operations

```bash
docker compose ps                 # status of all services
docker compose logs -f keycloak   # follow one service's logs
docker compose logs -f            # follow everything
docker compose restart pgbouncer  # restart a single service
docker compose stop               # stop (keep data)
docker compose down               # stop + remove containers (keep volumes)
docker compose down -v            # ⚠️ also wipe volumes (Postgres/Redis/MinIO data)
```

## First-boot behaviour

- **Postgres** runs `infra/postgres/init/01-create-databases.sh` on an empty data
  dir to create the `tre_crm` and `keycloak` databases + roles. This only runs
  once; to re-run, `docker compose down -v` and bring it back up.
- **keycloak-realm-render** renders `infra/keycloak/realm-export.template.json`
  (substituting `${SEED_ADMIN_PASSWORD}` etc. from `.env`) into a shared volume,
  then exits. **Keycloak** imports that rendered `realm-export.json`
  (`--import-realm`).
- **minio-init** creates the `tre-crm-files` bucket then exits (status `Exited
  (0)` is expected and healthy).

## Rebuilding the app image

```bash
docker compose build nextjs
docker compose --profile app up -d nextjs
```

The image is multi-stage and uses Next.js `output: "standalone"`. On container
start, `entrypoint.sh` runs `prisma migrate deploy` before launching the server.

## Volumes

| Volume      | Holds                |
| ----------- | -------------------- |
| `pgdata`    | Postgres data        |
| `redisdata` | Redis snapshots      |
| `miniodata` | Uploaded files       |

## Healthchecks

`postgres`, `redis` and `minio` declare healthchecks; dependent services wait on
them. Check app health at `GET http://localhost:3000/api/health`.

## Ports already in use?

If `5432`/`8080`/etc. clash with something local, change the **host** side of the
port mapping in `docker-compose.yml` (e.g. `"5433:5432"`) and the matching
`*_PORT` in `.env`.
