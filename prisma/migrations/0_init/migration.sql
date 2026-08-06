-- CreateEnum
CREATE TYPE "EnquiryStage" AS ENUM ('new_lead', 'contacted', 'rnr', 'qualified', 'pricing_shared', 'doctor_consultation', 'booking_confirmed', 'converted', 'lost');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('website_form', 'whatsapp', 'instagram', 'facebook', 'referral', 'walk_in', 'phone', 'other');

-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('medical', 'consent', 'operational', 'marketing');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('whatsapp', 'email', 'sms');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('open', 'done', 'cancelled');

-- CreateTable
CREATE TABLE "Guest" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "gender" TEXT,
    "city" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "referralCodeUsed" TEXT,
    "isReturning" BOOLEAN NOT NULL DEFAULT false,
    "consentGiven" BOOLEAN NOT NULL DEFAULT false,
    "consentAt" TIMESTAMP(3),
    "consentTextHash" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Guest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthProfile" (
    "id" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "encryptedData" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enquiry" (
    "id" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "stage" "EnquiryStage" NOT NULL DEFAULT 'new_lead',
    "source" "LeadSource" NOT NULL,
    "assignedToSub" TEXT,
    "assignedToName" TEXT,
    "packageId" TEXT,
    "referralCodeId" TEXT,
    "isReturningFlag" BOOLEAN NOT NULL DEFAULT false,
    "quotedPriceINR" INTEGER,
    "proposedDates" TEXT,
    "lostReason" TEXT,
    "campaignLabel" TEXT,
    "boardPosition" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Enquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "enquiryId" TEXT NOT NULL,
    "authorSub" TEXT NOT NULL,
    "authorName" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Package" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "basePriceINR" INTEGER NOT NULL,
    "therapies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "expiryDate" TIMESTAMP(3) NOT NULL,
    "creditsTotal" INTEGER NOT NULL DEFAULT 0,
    "creditsUsed" INTEGER NOT NULL DEFAULT 0,
    "discountPct" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "issuedToGuestId" TEXT,
    "campaignLabel" TEXT,
    "maxRedemptions" INTEGER NOT NULL DEFAULT 0,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "guestId" TEXT,
    "enquiryId" TEXT,
    "category" "DocumentCategory" NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "enquiryId" TEXT,
    "guestId" TEXT,
    "actorSub" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "actorName" TEXT,
    "actionType" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "enquiryId" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "body" TEXT NOT NULL,
    "templateId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "errorDetail" TEXT,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "enquiryId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "status" "TaskStatus" NOT NULL DEFAULT 'open',
    "assignedToSub" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPreference" (
    "id" TEXT NOT NULL,
    "userSub" TEXT NOT NULL,
    "prefs" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Guest_phone_key" ON "Guest"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Guest_email_key" ON "Guest"("email");

-- CreateIndex
CREATE INDEX "Guest_fullName_idx" ON "Guest"("fullName");

-- CreateIndex
CREATE INDEX "Guest_isReturning_idx" ON "Guest"("isReturning");

-- CreateIndex
CREATE INDEX "Guest_tags_idx" ON "Guest" USING GIN ("tags");

-- CreateIndex
CREATE UNIQUE INDEX "HealthProfile_guestId_key" ON "HealthProfile"("guestId");

-- CreateIndex
CREATE INDEX "Enquiry_stage_assignedToSub_idx" ON "Enquiry"("stage", "assignedToSub");

-- CreateIndex
CREATE INDEX "Enquiry_guestId_idx" ON "Enquiry"("guestId");

-- CreateIndex
CREATE INDEX "Enquiry_lastActivityAt_idx" ON "Enquiry"("lastActivityAt");

-- CreateIndex
CREATE INDEX "Note_enquiryId_createdAt_idx" ON "Note"("enquiryId", "createdAt");

-- CreateIndex
CREATE INDEX "Membership_guestId_status_idx" ON "Membership"("guestId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");

-- CreateIndex
CREATE INDEX "ReferralCode_code_idx" ON "ReferralCode"("code");

-- CreateIndex
CREATE INDEX "Document_guestId_idx" ON "Document"("guestId");

-- CreateIndex
CREATE INDEX "Document_enquiryId_idx" ON "Document"("enquiryId");

-- CreateIndex
CREATE INDEX "Activity_actorSub_createdAt_idx" ON "Activity"("actorSub", "createdAt");

-- CreateIndex
CREATE INDEX "Activity_enquiryId_idx" ON "Activity"("enquiryId");

-- CreateIndex
CREATE INDEX "Message_enquiryId_createdAt_idx" ON "Message"("enquiryId", "createdAt");

-- CreateIndex
CREATE INDEX "Task_assignedToSub_status_idx" ON "Task"("assignedToSub", "status");

-- CreateIndex
CREATE INDEX "Task_dueAt_idx" ON "Task"("dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserPreference_userSub_key" ON "UserPreference"("userSub");

-- AddForeignKey
ALTER TABLE "HealthProfile" ADD CONSTRAINT "HealthProfile_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enquiry" ADD CONSTRAINT "Enquiry_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enquiry" ADD CONSTRAINT "Enquiry_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enquiry" ADD CONSTRAINT "Enquiry_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "ReferralCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "Enquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "Enquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "Enquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "Enquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "Enquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

