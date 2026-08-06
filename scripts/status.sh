#!/usr/bin/env bash
# =============================================================================
# Show status of the Trē CRM stack: container state + app/DB/Redis health.
#
# Usage: scripts/status.sh
# =============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_docker

hr "Containers"
compose --profile app ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null \
  || compose ps

hr "App health"
if curl -fs http://localhost:3000/api/health 2>/dev/null; then
  echo
else
  warn "App not reachable on http://localhost:3000/api/health"
fi

hr "Service URLs"
cat <<'EOF'
  CRM app        http://localhost:3000
  Keycloak admin http://localhost:8080
  MinIO console  http://localhost:9001
  Mailhog UI     http://localhost:8025
EOF
