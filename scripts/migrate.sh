#!/usr/bin/env bash
# =============================================================================
# Apply Prisma migrations to the CRM database (prisma migrate deploy).
# Prefers host npm; falls back to a one-off container using the built app image.
#
# Usage: scripts/migrate.sh
# =============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_docker
ensure_env
wait_healthy postgres

if have_host_node; then
  log "Applying migrations (host)…"
  npm run prisma:deploy
else
  log "Applying migrations (one-off container)…"
  compose run --rm --no-deps "$APP_SERVICE" npx prisma migrate deploy \
    || die "Migration failed. Is the app image built? Run: scripts/build.sh app"
fi
log "Migrations applied."
