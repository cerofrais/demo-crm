-- Tag a lead automatically when an inbound WhatsApp message matches a word
-- or sentence, per number. Sibling of AutoReply.
CREATE TABLE "AutoTag" (
    "id" TEXT NOT NULL,
    "numberId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoTag_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AutoTag_numberId_enabled_idx" ON "AutoTag"("numberId", "enabled");

ALTER TABLE "AutoTag" ADD CONSTRAINT "AutoTag_numberId_fkey"
  FOREIGN KEY ("numberId") REFERENCES "WhatsAppNumber"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
