-- AlterTable
ALTER TABLE "BroadcastJob" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "broadcastJobId" TEXT;

-- CreateIndex
CREATE INDEX "Message_broadcastJobId_idx" ON "Message"("broadcastJobId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_broadcastJobId_fkey" FOREIGN KEY ("broadcastJobId") REFERENCES "BroadcastJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
