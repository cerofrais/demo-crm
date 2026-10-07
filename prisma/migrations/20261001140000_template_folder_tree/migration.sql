-- Template folders become rows that can nest, be renamed and be deleted,
-- instead of a free-text label on each template.
CREATE TABLE IF NOT EXISTS "MessageTemplateFolder" (
  "id"        TEXT NOT NULL,
  "channel"   "MessageTemplateChannel" NOT NULL,
  "name"      TEXT NOT NULL,
  "parentId"  TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageTemplateFolder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MessageTemplateFolder_channel_parentId_idx"
  ON "MessageTemplateFolder"("channel", "parentId");

DO $$ BEGIN
  ALTER TABLE "MessageTemplateFolder"
    ADD CONSTRAINT "MessageTemplateFolder_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "MessageTemplateFolder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "folderId" TEXT;

-- Carry over whatever filing the free-text column had held.
INSERT INTO "MessageTemplateFolder" ("id", "channel", "name", "createdBy")
SELECT gen_random_uuid(), "channel", btrim("folder"), 'migration'
FROM "MessageTemplate"
WHERE "folder" IS NOT NULL AND btrim("folder") <> ''
GROUP BY "channel", btrim("folder");

UPDATE "MessageTemplate" t
SET "folderId" = f."id"
FROM "MessageTemplateFolder" f
WHERE t."folder" IS NOT NULL AND btrim(t."folder") = f."name" AND t."channel" = f."channel";

-- Everything that was never filed goes to "Others", one per channel, so no
-- template sits outside the folder tree.
INSERT INTO "MessageTemplateFolder" ("id", "channel", "name", "createdBy")
SELECT gen_random_uuid(), "channel", 'Others', 'migration'
FROM "MessageTemplate"
WHERE "folderId" IS NULL
GROUP BY "channel";

UPDATE "MessageTemplate" t
SET "folderId" = f."id"
FROM "MessageTemplateFolder" f
WHERE t."folderId" IS NULL AND f."name" = 'Others' AND f."channel" = t."channel";

DO $$ BEGIN
  ALTER TABLE "MessageTemplate"
    ADD CONSTRAINT "MessageTemplate_folderId_fkey"
    FOREIGN KEY ("folderId") REFERENCES "MessageTemplateFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "MessageTemplate_folderId_idx" ON "MessageTemplate"("folderId");
DROP INDEX IF EXISTS "MessageTemplate_channel_folder_idx";
ALTER TABLE "MessageTemplate" DROP COLUMN IF EXISTS "folder";
