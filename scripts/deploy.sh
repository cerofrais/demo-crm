#!/usr/bin/env bash
# =============================================================================
# Deploy (bring up) the Trē CRM stack — a service, the infra, or everything.
#
# Usage:
#   scripts/deploy.sh                    # full stack (infra + app), build app
#   scripts/deploy.sh all  [--seed]      # infra + app; --seed loads sample data
#   scripts/deploy.sh infra [--seed]     # backing services only + run migrations
#   scripts/deploy.sh app  [--build]     # (re)deploy just the app container
#   scripts/deploy.sh postgres           # bring up a single backing service
#
# Flags:
#   --build        rebuild the app image before starting it
#   --seed         run the database seed after the stack is up
#   --no-migrate   skip running migrations (infra target only)
#
# Notes:
#   • The app container runs `prisma migrate deploy` on startup (entrypoint.sh),
#     so 'all'/'app' deploys migrate themselves. 'infra' runs migrations for you
#     (host npm if available, otherwise a one-off container).
#   • For local development you usually run `scripts/deploy.sh infra` and then
#     `npm run dev` on the host.
# =============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TARGET="${1:-all}"; shift || true
DO_BUILD=false; DO_SEED=false; DO_MIGRATE=true
for arg in "$@"; do
  case "$arg" in
    --build) DO_BUILD=true ;;
    --seed) DO_SEED=true ;;
    --no-migrate) DO_MIGRATE=false ;;
    *) die "Unknown flag '$arg'." ;;
  esac
done

require_docker
ensure_env

deploy_all() {
  hr "Deploy: ALL (infra + app)"
  $DO_BUILD && { log "Building app image…"; compose build "$APP_SERVICE"; }
  log "Starting backing services…"
  compose up -d "${INFRA_SERVICES[@]}"
  wait_healthy postgres
  wait_healthy redis
  log "Starting app (migrations run on container start)…"
  compose --profile app up -d --build "$APP_SERVICE"
  wait_http_health || compose logs --tail 30 "$APP_SERVICE"
  if [ -n "${NGROK_AUTHTOKEN:-}" ] && [ -n "${NGROK_DOMAIN:-}" ]; then
    log "Starting ngrok tunnel → https://${NGROK_DOMAIN}"
    compose --profile dev up -d ngrok
  fi
  $DO_SEED && "$ROOT_DIR/scripts/seed.sh"
  log "Stack is up → http://localhost:3000"
}

deploy_infra() {
  hr "Deploy: INFRA"
  log "Starting backing services…"
  compose up -d "${INFRA_SERVICES[@]}"
  wait_healthy postgres
  wait_healthy redis
  $DO_MIGRATE && "$ROOT_DIR/scripts/migrate.sh"
  $DO_SEED && "$ROOT_DIR/scripts/seed.sh"
  log "Infra is up. Run \`npm run dev\` for the app (host), or \`scripts/deploy.sh app\`."
}

deploy_app() {
  hr "Deploy: APP"
  $DO_BUILD && { log "Building app image…"; compose build "$APP_SERVICE"; }
  log "Starting app + its dependencies…"
  compose --profile app up -d "$APP_SERVICE"
  wait_http_health || compose logs --tail 30 "$APP_SERVICE"
  if [ -n "${NGROK_AUTHTOKEN:-}" ] && [ -n "${NGROK_DOMAIN:-}" ]; then
    log "Starting ngrok tunnel → https://${NGROK_DOMAIN}"
    compose --profile dev up -d ngrok
  fi
  log "App is up → http://localhost:3000"
}

deploy_one() {
  local svc="$1"
  hr "Deploy: $svc"
  compose up -d "$svc"
  wait_healthy "$svc"
  log "$svc is up."
}

case "$TARGET" in
  all)   deploy_all ;;
  infra) deploy_infra ;;
  app|nextjs) deploy_app ;;
  *)     deploy_one "$(resolve_service "$TARGET")" ;;
esac
