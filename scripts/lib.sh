#!/usr/bin/env bash
# =============================================================================
# Shared helpers for the Trē CRM ops scripts. Sourced by the other scripts.
# =============================================================================
set -euo pipefail

# Always operate from the repo root regardless of where the script is called.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ---- service catalogue ------------------------------------------------------
# Every selectable docker-compose service.
ALL_SERVICES=(postgres pgbouncer redis keycloak minio mailhog evolution-api nextjs ngrok)
# Backing services only (the app runs separately, often on the host in dev).
INFRA_SERVICES=(postgres pgbouncer redis keycloak minio minio-init mailhog evolution-api)
APP_SERVICE="nextjs"

# ---- colours / logging ------------------------------------------------------
if [ -t 1 ]; then
  C_GREEN='\033[0;32m'; C_YELLOW='\033[0;33m'; C_RED='\033[0;31m'
  C_BLUE='\033[0;36m'; C_BOLD='\033[1m'; C_RESET='\033[0m'
else
  C_GREEN=''; C_YELLOW=''; C_RED=''; C_BLUE=''; C_BOLD=''; C_RESET=''
fi
log()  { printf "${C_GREEN}▸${C_RESET} %s\n" "$*"; }
info() { printf "${C_BLUE}ℹ${C_RESET} %s\n" "$*"; }
warn() { printf "${C_YELLOW}⚠${C_RESET} %s\n" "$*" >&2; }
err()  { printf "${C_RED}✖ %s${C_RESET}\n" "$*" >&2; }
die()  { err "$*"; exit 1; }
hr()   { printf "${C_BOLD}── %s ──${C_RESET}\n" "$*"; }

# ---- guards -----------------------------------------------------------------
require_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed or not on PATH."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (\`docker compose\`)."
  docker info >/dev/null 2>&1 || die "Docker daemon is not running. Start Docker Desktop and retry."
}

ensure_env() {
  if [ ! -f .env ]; then
    warn ".env not found — creating it from .env.example (review the secrets!)."
    cp .env.example .env
  fi
}

compose() { docker compose "$@"; }

# Resolve aliases and validate a service name. Echoes the canonical name.
resolve_service() {
  local s="$1"
  [ "$s" = "app" ] && s="nextjs"
  for v in "${ALL_SERVICES[@]}" minio-init; do
    if [ "$s" = "$v" ]; then echo "$s"; return 0; fi
  done
  die "Unknown service '$1'. Valid: ${ALL_SERVICES[*]} (or 'all' / 'infra' / 'app')."
}

is_app() { [ "$1" = "$APP_SERVICE" ] || [ "$1" = "app" ]; }

# Wait until a container with a healthcheck reports healthy (no-op if none).
wait_healthy() {
  local name="tre-$1" timeout="${2:-90}" elapsed=0
  # Skip if the container has no health status defined.
  local has_health
  has_health="$(docker inspect -f '{{if .State.Health}}yes{{end}}' "$name" 2>/dev/null || true)"
  [ "$has_health" = "yes" ] || return 0
  printf "  waiting for %s to be healthy" "$name"
  while true; do
    local status
    status="$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || echo missing)"
    case "$status" in
      healthy) printf " ${C_GREEN}healthy${C_RESET}\n"; return 0 ;;
      unhealthy) printf "\n"; die "$name became unhealthy." ;;
    esac
    [ "$elapsed" -ge "$timeout" ] && { printf "\n"; die "Timed out waiting for $name."; }
    printf "."; sleep 2; elapsed=$((elapsed + 2))
  done
}

# Wait for the app's HTTP health endpoint.
wait_http_health() {
  local url="${1:-http://localhost:3000/api/health}" timeout="${2:-60}" elapsed=0
  printf "  waiting for %s" "$url"
  while ! curl -fs "$url" >/dev/null 2>&1; do
    [ "$elapsed" -ge "$timeout" ] && { printf "\n"; warn "App health endpoint not ready yet."; return 1; }
    printf "."; sleep 2; elapsed=$((elapsed + 2))
  done
  printf " ${C_GREEN}ok${C_RESET}\n"
}

have_host_node() { command -v npm >/dev/null 2>&1 && [ -x node_modules/.bin/prisma ]; }
