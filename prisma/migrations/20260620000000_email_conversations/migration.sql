-- AlterEnum
ALTER TYPE "LeadSource" ADD VALUE 'email';

-- AlterTable
ALTER TABLE "Guest" ALTER COLUMN "phone" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "bodyHtml" TEXT,
ADD COLUMN     "fromEmail" TEXT,
ADD COLUMN     "guestId" TEXT,
ADD COLUMN     "inReplyTo" TEXT,
ADD COLUMN     "mailboxId" TEXT NOT NULL DEFAULT 'sales',
ADD COLUMN     "messageId" TEXT,
ADD COLUMN     "needsReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "references" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "subject" TEXT,
ADD COLUMN     "toEmail" TEXT,
ALTER COLUMN "enquiryId" DROP NOT NULL,
ALTER COLUMN "channel" SET DEFAULT 'email';

-- CreateTable
CREATE TABLE "MailboxState" (
    "mailboxId" TEXT NOT NULL,
    "folder" TEXT NOT NULL DEFAULT 'INBOX',
    "lastUid" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailboxState_pkey" PRIMARY KEY ("mailboxId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Message_messageId_key" ON "Message"("messageId");

-- CreateIndex
CREATE INDEX "Message_guestId_mailboxId_createdAt_idx" ON "Message"("guestId", "mailboxId", "createdAt");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

