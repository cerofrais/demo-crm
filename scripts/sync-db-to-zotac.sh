#!/usr/bin/env bash
# =============================================================================
# Push this machine's CRM data to the zotac box.
#
#   Run ON harsha-pc-ubuntu (the live box):  scripts/sync-db-to-zotac.sh
#
# Streams a filtered pg_dump of tre_crm over the tailnet so zotac holds a
# current copy of production's GUEST-FACING RECORD for dev/testing.
#
# ── What it copies ───────────────────────────────────────────────────────────
#
#   Guests and everything about their dealings with us: enquiries, messages,
#   calls, notes, tasks, documents, activity, AI decisions, memberships,
#   health profiles, packages, referral codes, templates, tags, broadcast
#   jobs, staff profiles — plus the migration ledger, so zotac's schema
#   bookkeeping matches the schema it just received.
#
# ── What it deliberately does NOT copy, and why ──────────────────────────────
#
#   keycloak DB  — zotac has its OWN client redirect URIs registered (its
#                  tailnet hostname). Production's copy doesn't contain them,
#                  so restoring it leaves zotac unable to complete a login.
#                  Users/roles drift between the boxes as a result; that is
#                  the trade, and it is the right one for a box you need to
#                  be able to sign in to.
#
#   whatsapp DB  — Evolution's own database, holding Baileys session state for
#                  the live numbers. Copying it would arm zotac to reclaim
#                  sessions the production box is using the moment
#                  evolution-api starts there, which is exactly the conflict
#                  that corrupts a WhatsApp login (docs/21 §2.1).
#
#   and, INSIDE tre_crm, three kinds of table (see EXCLUDE below):
#
#     credentials      — WhatsAppNumber carries live instanceToken /
#                        metaAccessToken / wabaId. Copying it would hand zotac
#                        working credentials for production's numbers and let
#                        its CRM believe it owns them. AutoReply goes with it:
#                        it is FK-child of WhatsAppNumber, so its rows would
#                        reference numbers that don't exist on the target.
#
#     per-box config   — call routing, lead assignment/deletion settings, the
#                        round-robin cursor, mailbox poll cursors, per-user
#                        preferences. zotac is configured by hand; overwriting
#                        that from production is the thing this script exists
#                        to avoid.
#
#     dangling refs    — MarketingReport rows hold storageKeys pointing at
#                        MinIO objects that only exist on the source box, so
#                        copying them just produces broken downloads. Plus two
#                        ad-hoc *_backup tables left over from past fixes.
#
#   Excluding a table is NOT enough to protect it. TRUNCATE ... CASCADE wipes
#   every table holding a foreign key into a truncated one, and it does that
#   regardless of the FK's ON DELETE action — an ON DELETE SET NULL column
#   does not soften it. On 2026-08-20 this silently emptied the live box's
#   AutoReply during a sync, because AutoReply.attachmentDocumentId points at
#   Document, and Document is copied. The rule had to be recovered from a
#   backup.
#
#   So the guard is checked at RUN TIME, below: any excluded table with an FK
#   into a copied one has its rows saved before the truncate and restored
#   after. That keeps working when a future migration adds another such edge,
#   which a hand-maintained comment demonstrably did not.
#
# ── DATA ONLY: the target's schema is left alone ─────────────────────────────
#
#   This truncates and refills the copied tables rather than dropping and
#   recreating them. Dropping is what you'd reach for first, and it does not
#   work here: `pg_dump --clean` also emits DROP TYPE for every enum it dumps,
#   and those enums are shared with the tables we're holding back —
#   LeadAssignmentSettings.strategy uses LeadAssignmentStrategy, so the drop
#   is refused ("other objects depend on it") and the whole restore rolls
#   back. Excluding a table cannot exclude the type it depends on.
#
#   Copying rows only sidesteps that entirely, and is the better model anyway:
#   the target's schema belongs to the target's own migrations. It does mean
#   both boxes must be on the same migration — checked in pre-flight, and the
#   sync refuses rather than failing halfway through a restore.
#
# ── Why not scripts/restore-db.sh ────────────────────────────────────────────
#
#   That script restores a pg_dumpall stream over the EXISTING databases.
#   Every CREATE/INSERT then collides ("already exists", "duplicate key"),
#   psql keeps going, and it still exits 0 — reporting success having changed
#   nothing. This one runs inside a single transaction with ON_ERROR_STOP, so
#   it either applies completely or leaves the target exactly as it was.
#
# Usage:
#   scripts/sync-db-to-zotac.sh              # prompt before overwriting
#   scripts/sync-db-to-zotac.sh --yes        # no prompt (for cron)
#   scripts/sync-db-to-zotac.sh --dry-run    # show the plan, change nothing
#   scripts/sync-db-to-zotac.sh --force      # overwrite a target that looks live
#   REMOTE=zotac@100.116.193.105 scripts/sync-db-to-zotac.sh
# =============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REMOTE="${REMOTE:-zotac@100.116.193.105}"
REMOTE_DIR="${REMOTE_DIR:-/home/zotac/Desktop/gitrepo/tre-crm-tool}"
CONTAINER="tre-postgres"
DB="tre_crm"

# Tables held back from the sync. See the header for the reasoning behind each
# group; keep them grouped so a future reader can tell config from credentials.
EXCLUDE=(
  # credentials (and its FK children)
  WhatsAppNumber
  AutoReply
  AutoTag
  # per-box config / cursors
  CallRoutingSettings
  LeadAssignmentSettings
  LeadDeletionSettings
  LeadRoutingState
  MailboxState
  UserPreference
  # rows referencing storage objects that only exist on the source
  MarketingReport
  # schema bookkeeping — this sync never touches the target's schema, so its
  # migration ledger must keep describing its own schema, not the source's.
  _prisma_migrations
)

# Ad-hoc backup tables from past data fixes (transcript_fix_backup,
# Enquiry_tag_backup_20260814, …) are excluded by PATTERN, not by name: they
# are created outside migrations, so they exist only on the box where the fix
# ran — a new one on the source aborted a sync ("relation does not exist" on
# the target) the first time this list tried to keep up by hand.
BACKUP_PATTERN_SQL="tablename NOT ILIKE '%backup%'"

ASSUME_YES=false
DRY_RUN=false
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y)   ASSUME_YES=true ;;
    --dry-run)  DRY_RUN=true ;;
    --force)    FORCE=true ;;
    -h|--help)  sed -n '2,80p' "$0"; exit 0 ;;
    *)          die "Unknown option: $arg (try --help)" ;;
  esac
done

# pg_dump wants each one schema-qualified and quoted, since every Prisma table
# is CamelCase and would otherwise be folded to lower case.
EXCLUDE_ARGS=()
for t in "${EXCLUDE[@]}"; do
  EXCLUDE_ARGS+=(--exclude-table="public.\"$t\"")
done
# The backup-table pattern (see BACKUP_PATTERN_SQL above). Deliberately
# UNquoted, unlike the named exclusions: pg_dump treats double-quoted pattern
# text as literal (wildcards off), so "*backup*" would only match a table
# literally named *backup*. Unquoted, * is a real wildcard and matches
# case-sensitively, while the literal "backup" part is lowercase in every
# such table ("Enquiry_tag_backup_20260814", "wa_backfill_backup", …).
EXCLUDE_ARGS+=(--exclude-table='public.*backup*')

# The copied set is derived from the live schema rather than hardcoded, so a
# table added by a future migration is picked up automatically instead of
# being silently left behind.
EXCLUDE_SQL="$(printf "'%s'," "${EXCLUDE[@]}")"; EXCLUDE_SQL="${EXCLUDE_SQL%,}"

require_docker

# ---- pre-flight -------------------------------------------------------------
hr "pre-flight"

docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" \
  || die "$CONTAINER is not running here — nothing to dump."

ssh -o ConnectTimeout=10 -o BatchMode=yes "$REMOTE" true 2>/dev/null \
  || die "Can't reach $REMOTE over SSH. Is the box on, and is this machine's key authorised there?"

# ---- direction guard --------------------------------------------------------
#
# Two layers, because each covers the other's blind spot.
#
# 1. EXPLICIT: STANDBY=true marks a box that is no longer live. Deterministic,
#    and works from the very first second of a cutover.
if [ "${STANDBY:-false}" = "true" ] && [ "$FORCE" != "true" ]; then
  err "REFUSING: this box is marked STANDBY=true — it is not the live box."
  err "Pushing its data to $REMOTE would overwrite the live database with a stale copy."
  err "If you really mean to re-seed the target, re-run with --force."
  exit 1
fi
#
# 2. FRESHNESS: catches the case where nobody remembered to set the flag.
#
# This script only ever pushes THIS box's data over the target's. That is
# correct while the target is a test box, and catastrophic the moment the
# roles swap: on 2026-08-20 zotac became the live box, and a habitual re-run
# here would silently replace real guest data with a stale copy.
#
# Rather than rely on remembering, compare freshness. The live box is the one
# still receiving messages, so if the TARGET has newer traffic than the SOURCE,
# the direction is wrong. --force overrides, for the deliberate case of
# re-seeding a box you know is stale.
newest_message() {
  local runner="$1"
  $runner "docker exec $CONTAINER psql -U postgres -d $DB -tAc \
    \"SELECT COALESCE(EXTRACT(EPOCH FROM MAX(\\\"createdAt\\\"))::bigint, 0) FROM \\\"Message\\\";\"" 2>/dev/null | tr -d '[:space:]'
}

SRC_NEWEST="$(newest_message "bash -c")"
TGT_NEWEST="$(newest_message "ssh $REMOTE")"

if [ -n "$SRC_NEWEST" ] && [ -n "$TGT_NEWEST" ] && [ "$TGT_NEWEST" -gt "$((SRC_NEWEST + 300))" ]; then
  gap=$(( (TGT_NEWEST - SRC_NEWEST) / 60 ))
  if [ "$FORCE" != "true" ]; then
    err "REFUSING: $REMOTE has newer data than this box (its newest message is ${gap} min ahead)."
    err "That means the target is the LIVE box now and this sync would destroy real data."
    err "If you genuinely mean to overwrite it, re-run with --force."
    exit 1
  fi
  warn "Target is ${gap} min ahead of this box — overwriting anyway because --force was given."
fi
log "remote reachable: $REMOTE"

ssh "$REMOTE" "docker ps --format '{{.Names}}' | grep -qx $CONTAINER" \
  || die "$CONTAINER is not running on the remote — start its stack first."

# Refuse to run the wrong way round. Overwriting the live box would be
# unrecoverable, so check we are not pointed at ourselves.
LOCAL_ID="$(docker exec "$CONTAINER" psql -U postgres -tAc 'SELECT system_identifier FROM pg_control_system()')"
REMOTE_ID="$(ssh "$REMOTE" "docker exec $CONTAINER psql -U postgres -tAc 'SELECT system_identifier FROM pg_control_system()'")"
[ "$LOCAL_ID" != "$REMOTE_ID" ] \
  || die "Source and target are the SAME postgres cluster. Refusing to overwrite."

# Same schema on both sides, or the row copy has nowhere to land. Comparing
# the migration ledgers catches it here, with a clear fix, instead of halfway
# through a restore with a column-not-found error.
SRC_MIG="$(docker exec "$CONTAINER" psql -U "$DB" -d "$DB" -tAc \
  "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1")"
DST_MIG="$(ssh "$REMOTE" "docker exec $CONTAINER psql -U $DB -d $DB -tAc \"SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1\"")"
if [ "$SRC_MIG" != "$DST_MIG" ]; then
  err "Schema mismatch — this copies rows, not schema, so both boxes must be on the same migration."
  err "  this box: ${SRC_MIG:-none}"
  err "  $REMOTE: ${DST_MIG:-none}"
  die "Deploy the matching build on the remote first (its container runs migrations on start)."
fi
log "both boxes on migration: $SRC_MIG"

# Every table except the held-back ones. Ordered for a stable, readable plan.
mapfile -t INCLUDE < <(docker exec "$CONTAINER" psql -U "$DB" -d "$DB" -tAc \
  "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ($EXCLUDE_SQL) AND $BACKUP_PATTERN_SQL ORDER BY tablename")
[ "${#INCLUDE[@]}" -gt 0 ] || die "Resolved zero tables to copy — refusing to run."

# One statement: CASCADE stays inside the copied set (no excluded table
# references an included one), and doing it in the same transaction as the
# load means the target is never left empty.
TRUNCATE_SQL="TRUNCATE $(printf '"%s",' "${INCLUDE[@]}" | sed 's/,$//') RESTART IDENTITY CASCADE;"

# ---- cascade protection -----------------------------------------------------
# Excluded tables that CASCADE would take with it: those holding an FK into a
# table we're about to truncate. Discovered from the live FK graph rather than
# listed by hand, so a new edge added by a future migration is covered too.
INCLUDE_SQL="$(printf "'%s'," "${INCLUDE[@]}")"; INCLUDE_SQL="${INCLUDE_SQL%,}"
mapfile -t CASCADE_VICTIMS < <(ssh "$REMOTE" "docker exec $CONTAINER psql -U postgres -d $DB -tAc \"
  SELECT DISTINCT c.conrelid::regclass::text
  FROM pg_constraint c
  WHERE c.contype = 'f'
    AND replace(c.conrelid::regclass::text, '\\\"', '') IN ($EXCLUDE_SQL)
    AND replace(c.confrelid::regclass::text, '\\\"', '') IN ($INCLUDE_SQL);\"" 2>/dev/null \
  | tr -d '[:space:]"' | grep . || true)

if [ "${#CASCADE_VICTIMS[@]}" -gt 0 ]; then
  log "Held-back tables that CASCADE would wipe (rows preserved across the sync): ${CASCADE_VICTIMS[*]}"
fi

SRC_ROWS="$(docker exec "$CONTAINER" psql -U "$DB" -d "$DB" -tAc 'SELECT count(*) FROM "Enquiry"')"
DST_ROWS="$(ssh "$REMOTE" "docker exec $CONTAINER psql -U $DB -d $DB -tAc 'SELECT count(*) FROM \"Enquiry\"'" 2>/dev/null || echo "?")"
# Proof the exclusions held: this must be unchanged at the end.
DST_NUMBERS_BEFORE="$(ssh "$REMOTE" "docker exec $CONTAINER psql -U $DB -d $DB -tAc 'SELECT count(*) FROM \"WhatsAppNumber\"'" 2>/dev/null || echo "?")"

info "source (this box): $SRC_ROWS enquiries"
info "target ($REMOTE): $DST_ROWS enquiries — will be REPLACED"
info "copying ${#INCLUDE[@]} tables, holding back ${#EXCLUDE[@]}: ${EXCLUDE[*]}"
info "target keeps its own $DST_NUMBERS_BEFORE WhatsApp number(s)"

if $DRY_RUN; then
  hr "dry run"
  log "Nothing was changed. The plan:"
  echo "  copy   : ${INCLUDE[*]}"
  echo
  echo "  hold   : ${EXCLUDE[*]}"
  echo
  echo "  on the target, in ONE transaction:"
  echo "    $TRUNCATE_SQL"
  echo "    <data-only COPY stream for the copied tables>"
  exit 0
fi

if ! $ASSUME_YES; then
  warn "This replaces the CRM tables in '$DB' on $REMOTE. Their data is lost."
  read -r -p "Type 'sync' to continue: " CONFIRM
  [ "$CONFIRM" = "sync" ] || die "Aborted — nothing changed."
fi

# ---- stop the remote writer -------------------------------------------------
# nextjs only. evolution-api is deliberately left alone: on zotac it is kept
# stopped so it cannot claim the live WhatsApp sessions, and starting it here
# to "be tidy" would undo that.
hr "stopping remote app"
ssh "$REMOTE" "cd $REMOTE_DIR && docker compose stop nextjs" >/dev/null 2>&1 || true
log "nextjs stopped on remote"

# ---- dump + restore ---------------------------------------------------------
hr "syncing $DB"
info "streaming dump over the tailnet (no intermediate file)"

# The TRUNCATE is prepended to the dump so both land in the SAME psql
# transaction: ON_ERROR_STOP + --single-transaction means the target is either
# fully replaced or untouched, never emptied by a sync that then failed.
#
# --data-only: no DDL at all, so the target's schema and its enum types (which
# the held-back tables still depend on) are never touched. pg_dump orders the
# COPY blocks by dependency, so foreign keys hold as the data lands.
# Snapshot the tables CASCADE would take with it. Taken from the TARGET (they
# are the target's own config — that is why they're held back), and replayed
# after the copy so the cascade's damage is undone inside the same
# transaction. Empty when nothing is at risk.
CASCADE_RESTORE_SQL=""
for t in "${CASCADE_VICTIMS[@]}"; do
  dump="$(ssh "$REMOTE" "docker exec $CONTAINER pg_dump -U postgres --data-only --no-owner --no-acl -t 'public.\"$t\"' $DB" 2>/dev/null || true)"
  [ -n "$dump" ] && CASCADE_RESTORE_SQL+="$dump"$'\n'
done

set +e
{
  echo "$TRUNCATE_SQL"
  docker exec "$CONTAINER" pg_dump -U postgres --data-only --no-owner --no-acl \
    "${EXCLUDE_ARGS[@]}" "$DB"
  # Replayed last: the copied Documents/numbers these rows reference are in
  # place by now, so the foreign keys hold.
  printf '%s' "$CASCADE_RESTORE_SQL"
} \
  | gzip -1 \
  | ssh "$REMOTE" "gunzip | docker exec -i $CONTAINER psql -U postgres -d $DB -v ON_ERROR_STOP=1 --single-transaction" \
  2>/tmp/sync-db-zotac.err
PIPE_STATUS=("${PIPESTATUS[@]}")
set -e

for i in "${!PIPE_STATUS[@]}"; do
  [ "${PIPE_STATUS[$i]}" -eq 0 ] || {
    err "stage $i of the pipeline failed"
    sed -n '1,20p' /tmp/sync-db-zotac.err >&2
    die "Sync failed — the remote database was rolled back, not left half-written."
  }
done
log "$DB restored on remote"

# ---- bring the app back + verify -------------------------------------------
hr "restarting remote app"
# --no-deps: the nextjs service depends_on evolution-api, so a plain `start`
# of the whole service graph would launch Evolution on the remote and set it
# fighting this box for the live WhatsApp sessions.
ssh "$REMOTE" "cd $REMOTE_DIR && docker compose --profile app up -d --no-deps nextjs" >/dev/null 2>&1
log "nextjs started on remote (evolution-api left alone)"

hr "verifying"
NEW_ROWS="$(ssh "$REMOTE" "docker exec $CONTAINER psql -U $DB -d $DB -tAc 'SELECT count(*) FROM \"Enquiry\"'")"
info "source: $SRC_ROWS enquiries — target now: $NEW_ROWS"
[ "$SRC_ROWS" = "$NEW_ROWS" ] \
  || warn "Counts differ. Rows written here during the sync explain a small gap; a large one does not."

DST_NUMBERS_AFTER="$(ssh "$REMOTE" "docker exec $CONTAINER psql -U $DB -d $DB -tAc 'SELECT count(*) FROM \"WhatsAppNumber\"'")"
if [ "$DST_NUMBERS_BEFORE" = "$DST_NUMBERS_AFTER" ]; then
  log "target kept its own WhatsApp credentials ($DST_NUMBERS_AFTER row(s)) — exclusions held"
else
  err "WhatsAppNumber went from $DST_NUMBERS_BEFORE to $DST_NUMBERS_AFTER rows on the target."
  err "The credential exclusion did NOT hold. Check the --exclude-table quoting."
fi

# Confirm evolution-api really is still down over there.
if ssh "$REMOTE" "docker ps --format '{{.Names}}'" | grep -q evolution-api; then
  warn "evolution-api is RUNNING on $REMOTE — it can fight this box for the WhatsApp sessions."
  warn "Stop it with:  ssh $REMOTE 'docker stop tre-evolution-api'"
else
  log "evolution-api still stopped on remote (WhatsApp sessions safe)"
fi

for i in $(seq 1 30); do
  CODE="$(ssh "$REMOTE" "curl -s -o /dev/null -m 5 -w '%{http_code}' http://localhost:3000/api/health" 2>/dev/null || echo 000)"
  [ "$CODE" = "200" ] && { log "remote app healthy (200)"; break; }
  [ "$i" -eq 30 ] && warn "remote app not healthy yet — check: ssh $REMOTE 'docker logs --tail 50 tre-nextjs'"
  sleep 2
done

rm -f /tmp/sync-db-zotac.err
hr "done"
log "zotac now holds a copy of this box's CRM data, and none of its credentials."
