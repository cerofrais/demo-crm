#!/usr/bin/env bash
# =============================================================================
# Stop the Trē CRM stack — a single service or everything.
#
# Usage:
#   scripts/down.sh                 # stop & remove all containers (keep data)
#   scripts/down.sh all             # same
#   scripts/down.sh all --volumes   # ⚠️ also delete volumes (DB/Redis/MinIO data)
#   scripts/down.sh postgres        # stop a single service
# =============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TARGET="${1:-all}"; shift || true
WIPE=false
for arg in "$@"; do
  case "$arg" in
    --volumes|-v) WIPE=true ;;
    *) die "Unknown flag '$arg'." ;;
  esac
done

require_docker

if [ "$TARGET" = "all" ]; then
  if $WIPE; then
    warn "Removing ALL containers AND volumes (data will be lost)."
    compose --profile app down -v
  else
    hr "Stopping ALL"
    compose --profile app down
  fi
else
  SVC="$(resolve_service "$TARGET")"
  hr "Stopping $SVC"
  compose stop "$SVC"
  compose rm -f "$SVC"
fi
log "Done."
