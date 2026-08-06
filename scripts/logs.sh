#!/usr/bin/env bash
# =============================================================================
# Tail logs for the Trē CRM stack — a single service or everything.
#
# Usage:
#   scripts/logs.sh             # follow all services
#   scripts/logs.sh keycloak    # follow one service
#   scripts/logs.sh nextjs 200  # follow one service, last 200 lines
# =============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_docker

TARGET="${1:-all}"
TAIL="${2:-100}"

if [ "$TARGET" = "all" ]; then
  compose --profile app logs -f --tail "$TAIL"
else
  SVC="$(resolve_service "$TARGET")"
  compose logs -f --tail "$TAIL" "$SVC"
fi
