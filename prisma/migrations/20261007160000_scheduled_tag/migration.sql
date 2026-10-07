-- Tag everyone who messages a number during a window — the campaign case the
-- keyword rules cannot cover, because people answer an ad with "hi".
CREATE TABLE IF NOT EXISTS "ScheduledTag" (
  "id" TEXT NOT NULL,
  "numberId" TEXT NOT NULL,
  "tag" TEXT NOT NULL,
  "label" TEXT,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScheduledTag_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ScheduledTag_numberId_enabled_idx" ON "ScheduledTag"("numberId", "enabled");

DO $$ BEGIN
  ALTER TABLE "ScheduledTag"
    ADD CONSTRAINT "ScheduledTag_numberId_fkey"
    FOREIGN KEY ("numberId") REFERENCES "WhatsAppNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
