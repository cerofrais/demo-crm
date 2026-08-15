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

# ---- disk ------------------------------------------------------------------
# Docker's build cache grows by gigabytes per image build and is never
# reclaimed on its own. On the live box (an 88G root shared with Postgres and
# MinIO) it reached 8.3GB and filled the disk completely: a deploy died
# mid-build with "no space left on device", and Postgres was left sitting at
# zero bytes free — which is how a slow leak turns into lost writes.
#
# `--min-free-space` trims only as much cache as it takes to reach the target,
# so a box with room keeps its cache (and its fast incremental builds) while a
# tight one is cleared just enough to build. Nothing else is touched: images,
# containers and volumes are all left alone.
PRUNE_MIN_FREE_GB="${PRUNE_MIN_FREE_GB:-10}"

# Free GB on the filesystem holding Docker's data root — not necessarily "/".
docker_free_gb() {
  local root
  root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  df -PBG "$root" 2>/dev/null | awk 'NR==2 { gsub("G","",$4); print $4+0 }'
}

# Called before an image build. Safe to run every time: a no-op on a box that
# already has headroom.
prune_build_cache() {
  local before after
  before="$(docker_free_gb)"
  if [ -z "$before" ]; then
    warn "Couldn't read free disk space — skipping the build-cache check."
    return 0
  fi
  if [ "$before" -ge "$PRUNE_MIN_FREE_GB" ]; then
    info "disk: ${before}G free (>= ${PRUNE_MIN_FREE_GB}G) — keeping the build cache"
    return 0
  fi

  warn "disk: only ${before}G free — reclaiming Docker space to reach ${PRUNE_MIN_FREE_GB}G"
  # -a matters: without it BuildKit treats the cache from recent builds as
  # "in use" and reclaims nothing. On the live box a plain prune freed 0B
  # twice at 95% full, while `-af` immediately returned 5.6GB. The cost is a
  # cold first build afterwards, which is the right trade for a box that
  # would otherwise fail the build outright.
  # Never fatal: a failed prune shouldn't stop a deploy that might still fit.
  docker builder prune -af --min-free-space "${PRUNE_MIN_FREE_GB}GB" >/dev/null 2>&1 \
    || warn "build-cache prune failed — continuing anyway"
  # Dangling images too: every rebuild leaves the previous, now-untagged app
  # image behind, and those accumulate quietly. `image prune` without -a only
  # removes untagged images nothing references, so a tagged or running image
  # is never at risk.
  docker image prune -f >/dev/null 2>&1 \
    || warn "dangling-image prune failed — continuing anyway"
  after="$(docker_free_gb)"
  log "disk: ${before}G -> ${after}G free"
  [ "${after:-0}" -ge 3 ] \
    || warn "Still under 3G free. The build may fail — free space on this host (df -h /)."
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
