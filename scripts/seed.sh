#!/usr/bin/env bash
# =============================================================================
# Seed the CRM database with sample data (prisma db seed).
# The seed uses tsx (a dev dependency not present in the production image), so it
# runs from the host. Run `npm install` first if node_modules is missing.
#
# Usage: scripts/seed.sh
# =============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_docker
ensure_env
wait_healthy postgres

have_host_node || die "Host Node/Prisma not found. Run 'npm install' first (seed needs tsx)."

log "Seeding database…"
npm run db:seed
log "Seed complete."
