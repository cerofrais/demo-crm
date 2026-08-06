-- Hard-deletes every Enquiry currently soft-deleted (deletedAt IS NOT NULL)
-- at the time this is run — i.e. everything an admin has already removed
-- from the board via "Soft delete" in the lead drawer, or via the DELETE
-- /api/enquiries/:id?mode=soft route. Re-run this any time you want to
-- purge the current backlog of soft-deleted leads; it always operates on
-- whatever is soft-deleted *right now*, not a fixed list.
--
-- Mirrors the app's own in-app hard-delete (DELETE /api/enquiries/:id?mode=hard):
-- Notes and Tasks cascade-delete with the Enquiry (schema-enforced — they
-- only make sense tied to one specific lead). Everything that can span more
-- than one enquiry for the same guest — Messages, Calls, Documents, and the
-- Activity audit log — is detached (enquiryId set to NULL) instead of
-- deleted, so a guest's conversation/call history and the DPDP audit trail
-- survive the ticket going away.
--
-- This is IRREVERSIBLE. Take a fresh backup first:
--   docker compose exec -T postgres pg_dump -U tre_crm -d tre_crm > ~/tre-crm-backup-$(date +%Y%m%d-%H%M%S).sql
--
-- Run interactively (not piped) so you can read the sanity-check count
-- before it commits:
--   docker compose exec postgres psql -U tre_crm -d tre_crm -f /dev/stdin < scripts/misc/purge_soft_deleted_leads.sql
--
-- The whole thing runs inside one transaction — either everything below
-- happens or none of it does. If the sanity-check count looks wrong, kill
-- the process (or connect separately and ROLLBACK) before it reaches COMMIT.

BEGIN;

-- How many are about to be hard-deleted — review this before it commits.
SELECT count(*) AS about_to_hard_delete FROM "Enquiry" WHERE "deletedAt" IS NOT NULL;

-- Detach guest-level history instead of losing it.
UPDATE "Message"    SET "enquiryId" = NULL WHERE "enquiryId" IN (SELECT id FROM "Enquiry" WHERE "deletedAt" IS NOT NULL);
UPDATE "Call"       SET "enquiryId" = NULL WHERE "enquiryId" IN (SELECT id FROM "Enquiry" WHERE "deletedAt" IS NOT NULL);
UPDATE "Document"   SET "enquiryId" = NULL WHERE "enquiryId" IN (SELECT id FROM "Enquiry" WHERE "deletedAt" IS NOT NULL);
UPDATE "Activity"   SET "enquiryId" = NULL WHERE "enquiryId" IN (SELECT id FROM "Enquiry" WHERE "deletedAt" IS NOT NULL);
UPDATE "AiDecision" SET "enquiryId" = NULL WHERE "enquiryId" IN (SELECT id FROM "Enquiry" WHERE "deletedAt" IS NOT NULL);

-- Notes and Tasks cascade-delete automatically (onDelete: Cascade in schema).
DELETE FROM "Enquiry" WHERE "deletedAt" IS NOT NULL;

COMMIT;
