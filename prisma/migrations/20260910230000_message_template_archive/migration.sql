-- Archiving hides a template from pickers without deleting it. Null = active,
-- so every existing template stays exactly as visible as it is today.
ALTER TABLE "MessageTemplate"
    ADD COLUMN "archivedAt" TIMESTAMP(3),
    ADD COLUMN "archivedBy" TEXT;
