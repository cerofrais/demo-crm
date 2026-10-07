-- Optional tag applied to the lead when an email auto-reply rule matches.
-- Null for existing rules, which keep behaving exactly as before.
ALTER TABLE "EmailAutoReply" ADD COLUMN "tagOnMatch" TEXT;
