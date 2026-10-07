-- CreateTable
CREATE TABLE "EmailFooter" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "html" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL DEFAULT '',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailFooter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailAutoReply" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL DEFAULT 'sales',
    "triggerWord" TEXT,
    "subject" TEXT,
    "replyText" TEXT NOT NULL,
    "attachmentDocumentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "activeFromMin" INTEGER,
    "activeToMin" INTEGER,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailAutoReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailAutoReply_mailboxId_enabled_idx" ON "EmailAutoReply"("mailboxId", "enabled");

-- AlterTable
-- Marks an outbound message as machine-generated. Also the cooldown key:
-- "did we auto-reply to this address recently" needs no extra table.
ALTER TABLE "Message" ADD COLUMN "autoReplyRuleId" TEXT;
CREATE INDEX "Message_autoReplyRuleId_toEmail_idx" ON "Message"("autoReplyRuleId", "toEmail");
