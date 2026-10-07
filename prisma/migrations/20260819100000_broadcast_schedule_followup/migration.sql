-- Scheduled sends + follow-up campaigns targeting a prior broadcast's
-- non-responders (Stage 3 of the campaign flow).

ALTER TABLE "BroadcastJob" ADD COLUMN "scheduledAt" TIMESTAMP(3);
ALTER TABLE "BroadcastJob" ADD COLUMN "followUpOfJobId" TEXT;

ALTER TABLE "BroadcastJob" ADD CONSTRAINT "BroadcastJob_followUpOfJobId_fkey"
  FOREIGN KEY ("followUpOfJobId") REFERENCES "BroadcastJob"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The worker scans for "due" jobs on every tick.
CREATE INDEX "BroadcastJob_scheduledAt_idx" ON "BroadcastJob"("scheduledAt");
