-- AlterTable
-- Nullable: existing leads simply have no room count recorded.
ALTER TABLE "Enquiry" ADD COLUMN "roomCount" INTEGER;
