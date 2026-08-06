#!/usr/bin/env bash
# =============================================================================
# Build images for the Trē CRM stack.
#   - nextjs (the app) is built from infra/docker/Dockerfile
#   - every other service uses a published image, so "build" = pull it
#
# Usage:
#   scripts/build.sh                 # build/pull everything
#   scripts/build.sh all             # same as above
#   scripts/build.sh infra           # pull the backing-service images only
#   scripts/build.sh nextjs|app      # build just the app image
#   scripts/build.sh postgres        # pull a single service image
#   scripts/build.sh app --no-cache  # pass extra flags through to the builder
# =============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TARGET="${1:-all}"; shift || true
EXTRA_ARGS=("$@")   # forwarded to `docker compose build` (e.g. --no-cache)

require_docker
ensure_env

build_one() {
  local svc="$1"
  if is_app "$svc"; then
    log "Building app image (nextjs)…"
    compose build "${EXTRA_ARGS[@]}" nextjs
  else
    log "Pulling image for $svc…"
    compose pull "$svc"
  fi
}

case "$TARGET" in
  all)
    hr "Build: ALL"
    log "Pulling backing-service images…"
    compose pull "${INFRA_SERVICES[@]}"
    log "Building app image…"
    compose build "${EXTRA_ARGS[@]}" "$APP_SERVICE"
    ;;
  infra)
    hr "Build: INFRA"
    compose pull "${INFRA_SERVICES[@]}"
    ;;
  *)
    SVC="$(resolve_service "$TARGET")"
    hr "Build: $SVC"
    build_one "$SVC"
    ;;
esac

log "Build complete."
