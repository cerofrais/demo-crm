-- AlterTable
ALTER TABLE "Guest" ADD COLUMN     "blockedAt" TIMESTAMP(3),
ADD COLUMN     "blockedBySub" TEXT,
ADD COLUMN     "isBlocked" BOOLEAN NOT NULL DEFAULT false;
