-- AlterTable
ALTER TABLE "WhatsAppNumber" ADD COLUMN     "integration" TEXT NOT NULL DEFAULT 'baileys',
ADD COLUMN     "metaAccessToken" TEXT,
ADD COLUMN     "metaPhoneNumberId" TEXT,
ADD COLUMN     "wabaId" TEXT;
