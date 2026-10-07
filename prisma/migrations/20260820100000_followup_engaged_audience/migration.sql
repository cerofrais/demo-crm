-- Stage 3 targets ENGAGED-then-quiet guests (tapped the button, got the
-- pricing, went silent) rather than people who never responded at all.
ALTER TABLE "BroadcastJob" ADD COLUMN "followUpTrigger" TEXT;
ALTER TABLE "BroadcastJob" ADD COLUMN "followUpQuietHours" INTEGER;
