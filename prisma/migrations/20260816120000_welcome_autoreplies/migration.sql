-- Welcome auto-replies + schedules: a per-number WhatsApp welcome for
-- brand-new senders (AutoReply.kind=welcome), a singleton config for the
-- onboarding email sent when a new guest's email first enters the CRM, and
-- an optional daily IST active window on both.

-- CreateEnum
CREATE TYPE "AutoReplyKind" AS ENUM ('trigger', 'welcome');

-- AlterTable (existing rows are all trigger-based — the default matches)
ALTER TABLE "AutoReply" ADD COLUMN "kind" "AutoReplyKind" NOT NULL DEFAULT 'trigger';
ALTER TABLE "AutoReply" ADD COLUMN "activeFromMin" INTEGER;
ALTER TABLE "AutoReply" ADD COLUMN "activeToMin" INTEGER;

-- CreateTable
CREATE TABLE "WelcomeEmailSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "activeFromMin" INTEGER,
    "activeToMin" INTEGER,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WelcomeEmailSetting_pkey" PRIMARY KEY ("id")
);
