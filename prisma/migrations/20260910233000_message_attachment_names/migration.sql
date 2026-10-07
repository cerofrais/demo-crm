-- Filenames of the attachments an email carried, sent or received. Names
-- only: received files are not stored. Empty for every existing message —
-- received attachments were never recorded, so there is nothing to backfill.
ALTER TABLE "Message" ADD COLUMN "attachmentNames" TEXT[] DEFAULT ARRAY[]::TEXT[];
