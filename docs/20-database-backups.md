# 20 — Automated database backups

Every 6 hours, `scripts/backup-db.sh` dumps all three databases sharing the
one Postgres container (`tre_crm`, `keycloak`, Evolution's WhatsApp DB) to a
single gzipped file on the **host** filesystem — not a Docker volume, so a
corrupted `pgdata` volume can't take the backups down with it. Backups older
than 2 days are pruned automatically, so at steady state you always have the
last ~8 snapshots (48 hours) to recover from.

This is the same `pg_dumpall` technique [19 — server migration](./19-server-migration.md)
uses to move the whole server — a backup file from here is a valid input to
that runbook's restore step too.

---

## What it does, and doesn't, protect against

**Protects against:** a bad migration, a bug that corrupts/deletes data, an
accidental `DROP TABLE`, disk-level Postgres corruption — anything where you'd
want to rewind the database to an earlier point in time.

**Doesn't protect against:** losing the machine entirely (fire, disk failure,
theft) — these backups live on the *same* box as the database they're backing
up. If that's a real risk, `rsync ~/tre-backups` to a second machine or object
storage on the same schedule; the retention/pruning logic doesn't care where
the files end up copied to afterward.

**Doesn't cover:** uploaded files (MinIO/`miniodata`) or WhatsApp session
state (`evolutioninstances`) — those aren't in a `pg_dumpall`. See
[19 — server migration §3b](./19-server-migration.md#3b-volumes--everything-postgres-doesnt-cover)
if you need those covered too; they change far less often than the database,
so a periodic manual tarball is usually enough.

---

## Set up the schedule

The script itself has no scheduler built in — it's a plain script, run by
`cron` on the host (same "lives outside Docker" pattern as Ollama in the
migration runbook).

```bash
crontab -e
```

Add:

```cron
0 */6 * * * cd ~/Desktop/gitrepo/tre-crm-tool && ./scripts/backup-db.sh >> ~/tre-backups/backup.log 2>&1
```

Runs at 00:00, 06:00, 12:00, 18:00. Verify it's registered:

```bash
crontab -l | grep backup-db
```

## Run it manually / verify it's working

```bash
./scripts/backup-db.sh
ls -lh ~/tre-backups/
tail -20 ~/tre-backups/backup.log
```

A healthy run logs the backup path + size, then the pruned count (if any) and
the total backups on disk. The script **never deletes anything if the current
dump fails or looks truncated** — a bad run leaves prior backups untouched
rather than silently thinning out your safety margin.

## Restore from a backup

```bash
./scripts/restore-db.sh                          # newest backup in ~/tre-backups
./scripts/restore-db.sh ~/tre-backups/tre-backup-20260725-060000.sql.gz   # a specific one
```

This is **destructive** — it overwrites the live databases and asks for a
typed `restore` confirmation first. It stops `nextjs` + `evolution-api`
(the writers) before restoring and starts them back up after, same
before/after step as the migration runbook's own restore (§5e).

Anything written to the CRM after the backup's timestamp is lost — that's the
tradeoff of a point-in-time restore. Spot-check a recent lead, the WhatsApp
Numbers page (should still show **Connected** without re-scanning a QR — same
proof-of-restore signal as the migration runbook §7), and a health record
before trusting the restored state fully.

## Tuning retention or location

```bash
BACKUP_DIR=/mnt/external/tre-backups BACKUP_RETENTION_DAYS=7 ./scripts/backup-db.sh
```

Set the same env vars in the cron line if you want a non-default location or
window permanently — cron doesn't inherit your interactive shell's env, so
export them inline in the crontab entry, not in `~/.bashrc`.
