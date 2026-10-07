-- Email auto-replies gain subject matching and multiple terms per field.
-- Safe to drop triggerWord outright: no rule has ever been created (the
-- feature shipped hours ago and the table is empty), so there is nothing to
-- migrate across.
ALTER TABLE "EmailAutoReply"
    DROP COLUMN "triggerWord",
    ADD COLUMN "subjectTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "bodyTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "termMatch" TEXT NOT NULL DEFAULT 'any';
