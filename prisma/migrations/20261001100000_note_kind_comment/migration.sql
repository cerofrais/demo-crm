-- Internal comments, kept out of the Cresent report. Everything written
-- before now is a remark, which is what it was.
DO $$ BEGIN
  CREATE TYPE "NoteKind" AS ENUM ('remark', 'comment');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Note" ADD COLUMN IF NOT EXISTS "kind" "NoteKind" NOT NULL DEFAULT 'remark';
