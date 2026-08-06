#!/usr/bin/env bash
# =============================================================================
# Restore a backup made by scripts/backup-db.sh. DESTRUCTIVE — overwrites the
# live tre_crm/keycloak/Evolution databases with the dump's contents. Stops
# the writers (nextjs, evolution-api) first so nothing races the restore.
#
# Usage: scripts/restore-db.sh [path/to/tre-backup-*.sql.gz]
#        (defaults to the newest file in BACKUP_DIR if omitted)
# =============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BACKUP_DIR="${BACKUP_DIR:-$HOME/tre-backups}"
CONTAINER="tre-postgres"

FILE="${1:-}"
if [ -z "$FILE" ]; then
  FILE="$(find "$BACKUP_DIR" -maxdepth 1 -name 'tre-backup-*.sql.gz' | sort | tail -1)"
  [ -n "$FILE" ] || die "No backup file given and none found in $BACKUP_DIR."
  info "No file given — using the newest: $FILE"
fi
[ -f "$FILE" ] || die "File not found: $FILE"

warn "This OVERWRITES the live tre_crm, keycloak, and WhatsApp databases with:"
warn "  $FILE"
warn "Everything written since that backup was taken will be lost."
read -r -p "Type 'restore' to continue: " CONFIRM
[ "$CONFIRM" = "restore" ] || die "Aborted — no changes made."

log "Stopping nextjs + evolution-api (writers)..."
compose stop nextjs evolution-api

log "Restoring $FILE into $CONTAINER..."
if ! gunzip -c "$FILE" | docker exec -i "$CONTAINER" psql -U postgres; then
  err "Restore hit errors — check output above. Databases may be in a partial state."
  err "Re-run against a known-good backup, or restore this same file again (psql restores are idempotent per-statement)."
  exit 1
fi

log "Restore complete. Bringing nextjs + evolution-api back up..."
compose start nextjs evolution-api
wait_http_health

log "Done. Spot-check a lead/guest and the WhatsApp Numbers page before trusting this fully."
