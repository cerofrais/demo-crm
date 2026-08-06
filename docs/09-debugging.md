# 09 — Debugging & command cheat-sheet

## Health & status

```bash
curl -s http://localhost:3000/api/health | jq   # app: DB + Redis ping
docker compose ps                                # container status
docker compose logs -f nextjs                    # app logs (if running in Docker)
```

## Database

```bash
# psql into the CRM database (from host, via the container)
docker compose exec postgres psql -U tre_crm -d tre_crm

# psql into the Keycloak database
docker compose exec postgres psql -U keycloak -d keycloak

# list databases (confirm both exist)
docker compose exec postgres psql -U postgres -c "\l"

# Prisma
npm run prisma:studio          # GUI browser at http://localhost:5555
npm run prisma:deploy          # apply pending migrations
npx prisma migrate status      # what's applied / pending
npm run db:seed                # reload sample data
```

### "Database does not exist" / init script didn't run
The init script only runs on an **empty** Postgres volume. Reset it:
```bash
docker compose down -v && docker compose up -d postgres
docker compose logs postgres | grep '\[init\]'
```

### Prisma can't connect / pooling errors
- Runtime uses `DATABASE_URL` (PgBouncer, port 6432). Migrations need
  `DIRECT_DATABASE_URL` (Postgres, port 5432). Make sure both are set.
- With PgBouncer in transaction mode, keep `?pgbouncer=true` on `DATABASE_URL`.

## Keycloak

```bash
docker compose logs -f keycloak                  # watch realm import
# realm import happens once; to re-import after editing realm-export.template.json
# or SEED_ADMIN_PASSWORD, re-render first, then restart Keycloak:
docker compose up -d keycloak-realm-render && docker compose restart keycloak
```

- **Login redirect loops / "invalid issuer":** browser and server must agree on
  the Keycloak host. In dev run the app on the host so both use
  `localhost:8080`. See [05 — Auth](./05-auth-keycloak.md).
- **"Invalid client credentials":** `KEYCLOAK_CLIENT_SECRET` in `.env` must match
  the `tre-crm` client secret in Keycloak (Clients → tre-crm → Credentials).
- **Can't reach admin console:** http://localhost:8080, user/pass from
  `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`.

## Redis

```bash
docker compose exec redis redis-cli ping         # -> PONG
docker compose exec redis redis-cli keys '*'     # inspect keys (dev only)
```

## MinIO

```bash
# console: http://localhost:9001  (STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY)
docker compose logs minio-init                   # confirm bucket creation
```

## Email (dev)

All outbound mail is caught by Mailhog — open http://localhost:8025. Nothing
leaves your machine.

## App build / type issues

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run build          # prisma generate + next build
rm -rf .next           # clear a stale Next.js cache
```

## Webhook testing

```bash
ngrok http 3000        # expose locally for external providers
```
See [07 — Kanban](./07-kanban-sales-flow.md) for a signed `curl` example.

## Ports in use
Change the **host** side of the mapping in `docker-compose.yml` (e.g.
`"5433:5432"`) and the matching `.env` value, then `docker compose up -d`.

## Full reset (nuclear)

```bash
docker compose down -v       # remove containers + volumes (all data lost)
rm -rf .next node_modules
npm install
docker compose up -d postgres pgbouncer redis keycloak minio minio-init mailhog
npm run prisma:deploy && npm run db:seed && npm run dev
```
