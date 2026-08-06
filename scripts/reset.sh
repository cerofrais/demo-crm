#!/usr/bin/env bash
# =============================================================================
# Nuclear reset: tear everything down (incl. volumes), rebuild infra, migrate,
# and seed. Destroys all local data. Asks for confirmation unless --yes.
#
# Usage:
#   scripts/reset.sh           # prompts before wiping
#   scripts/reset.sh --yes     # no prompt (CI / scripted)
# =============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_docker
ensure_env

if [ "${1:-}" != "--yes" ]; then
  warn "This will DELETE all local data (Postgres, Redis, MinIO volumes)."
  read -r -p "Type 'reset' to continue: " ans
  [ "$ans" = "reset" ] || die "Aborted."
fi

hr "Reset"
log "Tearing down (with volumes)…"
compose --profile app down -v

log "Starting fresh infra…"
compose up -d "${INFRA_SERVICES[@]}"
wait_healthy postgres
wait_healthy redis

"$ROOT_DIR/scripts/migrate.sh"
"$ROOT_DIR/scripts/seed.sh"

log "Reset complete. Run \`npm run dev\` or \`scripts/deploy.sh app\`."
