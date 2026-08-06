-- AlterTable
ALTER TABLE "BroadcastJob" ADD COLUMN     "templateBodyParams" JSONB,
ADD COLUMN     "templateLanguage" TEXT,
ADD COLUMN     "templateName" TEXT;
