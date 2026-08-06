# Misc scripts

One-off / occasional DB maintenance scripts — not part of the normal
build/deploy/operate flow in [`../`](../README.md), and not run automatically
by anything. Run by hand, against the deployed box, only when you actually
need them.

Unlike the `.sh` wrappers one level up, these are raw `.sql` files meant to
be reviewed before running — copy the relevant one onto the box, read it, then
execute it directly against Postgres.

| Script | Description | Command |
| ------ | ------------ | ------- |
| `purge_soft_deleted_leads.sql` | Hard-deletes every currently soft-deleted lead (`Enquiry.deletedAt IS NOT NULL`) — i.e. empties the "trash" of leads already removed from the board via Soft delete. **Irreversible.** Notes/Tasks are dropped with the lead (schema-cascaded); Messages/Calls/Documents/Activity are detached (`enquiryId` → `NULL`) rather than deleted, so a guest's conversation history, call log, and DPDP audit trail survive. | `docker compose exec postgres psql -U tre_crm -d tre_crm -f /dev/stdin < scripts/misc/purge_soft_deleted_leads.sql` |

## Before running any of these

1. **Back up first** — every script here mutates or deletes production data:
   ```bash
   docker compose exec -T postgres pg_dump -U tre_crm -d tre_crm > ~/tre-crm-backup-$(date +%Y%m%d-%H%M%S).sql
   ```
2. **Read the script.** Each one is commented with what it does and why.
3. **Run it interactively** (piped via `-f /dev/stdin < file.sql`, not
   `psql < file.sql` in a way that hides output) so you see any sanity-check
   counts the script prints before it commits. Every script here wraps its
   work in `BEGIN … COMMIT` — if a printed count looks wrong, kill the
   process or `ROLLBACK` in a separate session before it reaches `COMMIT`.
