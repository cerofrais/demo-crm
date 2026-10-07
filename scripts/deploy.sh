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
#   • Before any image build, Docker's build cache is trimmed if free disk has
#     dropped below PRUNE_MIN_FREE_GB (default 10). A cache left to grow filled
#     the live box's root and failed a deploy mid-build; a box with headroom is
#     untouched and keeps its fast incremental builds.
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

# A box that is NOT the live one (STANDBY=true in its .env) must not grab the
# things only one box may own. Two specific hazards, both learned the hard way:
#
#   ngrok  — a single free-tier endpoint. Starting it here yanks the public
#            URL away from the live box, and every Meta/Plivo webhook with it.
#   evolution-api — nextjs depends_on it, so a plain `up -d nextjs` starts it
#            as a dependency. It would then reconnect the shared WhatsApp
#            numbers and start answering guests in parallel with the live box.
#
# Deploying a standby is still useful (build, migrate, test the UI); it just
# stays off the air.
STANDBY="${STANDBY:-false}"
if [ "$STANDBY" = "true" ]; then
  warn "STANDBY=true — this box will not start ngrok or evolution-api."
fi

# `--no-deps` on a standby keeps evolution-api down; the live box keeps the
# dependency so a normal deploy still brings its stack up.
app_up_flags() {
  [ "$STANDBY" = "true" ] && printf -- "--no-deps"
}

start_tunnel_if_wanted() {
  if [ "$STANDBY" = "true" ]; then
    log "Skipping ngrok — STANDBY box (the live box owns https://${NGROK_DOMAIN:-the tunnel})."
    return
  fi
  if [ -n "${NGROK_AUTHTOKEN:-}" ] && [ -n "${NGROK_DOMAIN:-}" ]; then
    log "Starting ngrok tunnel → https://${NGROK_DOMAIN}"
    compose --profile dev up -d ngrok
  fi
}

deploy_all() {
  hr "Deploy: ALL (infra + app)"
  $DO_BUILD && { prune_build_cache; log "Building app image…"; compose build "$APP_SERVICE"; }
  log "Starting backing services…"
  compose up -d "${INFRA_SERVICES[@]}"
  wait_healthy postgres
  wait_healthy redis
  log "Starting app (migrations run on container start)…"
  prune_build_cache
  compose --profile app up -d --build $(app_up_flags) "$APP_SERVICE"
  wait_http_health || compose logs --tail 30 "$APP_SERVICE"
  start_tunnel_if_wanted
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
  $DO_BUILD && { prune_build_cache; log "Building app image…"; compose build "$APP_SERVICE"; }
  log "Starting app + its dependencies…"
  compose --profile app up -d $(app_up_flags) "$APP_SERVICE"
  wait_http_health || compose logs --tail 30 "$APP_SERVICE"
  start_tunnel_if_wanted
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
