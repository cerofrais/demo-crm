-- A health record is now one screening-form submission, not one per guest.
-- Dropping this unique index is the whole point: a family shares a phone,
-- Guest.phone is unique, so three siblings resolved to one guest and their
-- three forms were merged into a single record.
DROP INDEX "HealthProfile_guestId_key";

-- AlterTable
ALTER TABLE "HealthProfile"
    ADD COLUMN "subjectName" TEXT,
    ADD COLUMN "subjectPhone" TEXT,
    ADD COLUMN "hasDuplicate" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "sourceMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "HealthProfile_sourceMessageId_key" ON "HealthProfile"("sourceMessageId");
CREATE INDEX "HealthProfile_guestId_idx" ON "HealthProfile"("guestId");
CREATE INDEX "HealthProfile_subjectPhone_subjectName_idx" ON "HealthProfile"("subjectPhone", "subjectName");
