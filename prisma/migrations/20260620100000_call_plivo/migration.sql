-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('initiated', 'ringing', 'connected', 'completed', 'no_answer', 'failed', 'voicemail');

-- CreateTable
CREATE TABLE "StaffProfile" (
    "keycloakId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "phone" TEXT,
    "isOnline" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffProfile_pkey" PRIMARY KEY ("keycloakId")
);

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL,
    "direction" "CallDirection" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'initiated',
    "callUUID" TEXT,
    "guestId" TEXT,
    "enquiryId" TEXT,
    "repKeycloakId" TEXT,
    "repName" TEXT,
    "repPhone" TEXT,
    "customerPhone" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "recordingUrl" TEXT,
    "recordingDurSec" INTEGER,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Call_callUUID_key" ON "Call"("callUUID");

-- CreateIndex
CREATE INDEX "Call_guestId_idx" ON "Call"("guestId");

-- CreateIndex
CREATE INDEX "Call_enquiryId_idx" ON "Call"("enquiryId");

-- CreateIndex
CREATE INDEX "Call_callUUID_idx" ON "Call"("callUUID");

-- CreateIndex
CREATE INDEX "Call_repKeycloakId_idx" ON "Call"("repKeycloakId");

-- CreateIndex
CREATE INDEX "Call_startedAt_idx" ON "Call"("startedAt");

-- CreateIndex
CREATE INDEX "Call_tags_idx" ON "Call" USING GIN ("tags");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "Enquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
