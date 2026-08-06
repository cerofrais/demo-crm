#!/usr/bin/env bash
# =============================================================================
# Point-in-time DB backup — dumps all three databases (tre_crm, keycloak,
# Evolution's WhatsApp DB) sharing the one Postgres container, on a schedule
# (see infra/backup/README.md for the cron entry), keeping BACKUP_RETENTION_DAYS
# worth of history and pruning anything older.
#
# Written to survive Postgres/Docker itself going bad — files land on the host
# filesystem (BACKUP_DIR), not in a Docker volume, so a corrupted pgdata volume
# doesn't take the backups down with it.
#
# Usage: scripts/backup-db.sh
# Env:   BACKUP_DIR (default ~/tre-backups), BACKUP_RETENTION_DAYS (default 2)
# =============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BACKUP_DIR="${BACKUP_DIR:-$HOME/tre-backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-2}"
CONTAINER="tre-postgres"
TS="$(date +%Y%m%d-%H%M%S)"
FINAL="$BACKUP_DIR/tre-backup-$TS.sql.gz"
TMP="$FINAL.tmp"

mkdir -p "$BACKUP_DIR"

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  die "$CONTAINER isn't running — nothing to back up."
fi

log "Dumping all databases from $CONTAINER..."
# pg_dumpall (not pg_dump) — same reasoning as the migration runbook (docs/19):
# one Postgres instance backs tre_crm, keycloak, and Evolution's WhatsApp DB,
# plus roles; a single-database dump would silently lose the other two on restore.
if ! docker exec "$CONTAINER" pg_dumpall -U postgres | gzip > "$TMP"; then
  rm -f "$TMP"
  die "pg_dumpall failed — left prior backups untouched, nothing deleted."
fi

# Sanity check before trusting it — an empty/truncated dump is worse than no
# backup at all if it silently displaces a good one in the retention window.
SIZE=$(stat -f%z "$TMP" 2>/dev/null || stat -c%s "$TMP" 2>/dev/null || echo 0)
if [ "$SIZE" -lt 10000 ]; then
  rm -f "$TMP"
  die "Dump suspiciously small (${SIZE} bytes) — aborted, prior backups untouched."
fi
if ! gzip -t "$TMP" 2>/dev/null; then
  rm -f "$TMP"
  die "Dump failed gzip integrity check — aborted, prior backups untouched."
fi

mv "$TMP" "$FINAL"
log "Backup written: $FINAL ($(du -h "$FINAL" | cut -f1))"

# Retention — only runs after a verified-good backup lands, so a bad run
# never thins out the history it was supposed to add to.
DELETED=$(find "$BACKUP_DIR" -maxdepth 1 -name 'tre-backup-*.sql.gz' -mtime "+$BACKUP_RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')
[ "$DELETED" -gt 0 ] && log "Pruned $DELETED backup(s) older than $BACKUP_RETENTION_DAYS days."

log "Done. $(find "$BACKUP_DIR" -maxdepth 1 -name 'tre-backup-*.sql.gz' | wc -l | tr -d ' ') backup(s) on disk."
