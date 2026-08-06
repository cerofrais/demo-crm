-- Tracks the IMAP UIDVALIDITY of the account currently behind each mailboxId
-- ("sales"/"doctor"). UIDs are only comparable within one (server,
-- UIDVALIDITY) pair — without this, repointing a mailbox's env creds at a
-- different account made the stored lastUid meaningless in the new account's
-- UID space, and the poller imported its entire inbox as unread mail.
ALTER TABLE "MailboxState" ADD COLUMN "uidValidity" BIGINT;
