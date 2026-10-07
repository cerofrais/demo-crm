-- Rolling follow-ups: chase each guest on their own clock rather than sending
-- one batch at a fixed time. NULL keeps the existing one-shot behaviour, so
-- every job created before this migration is unaffected.
ALTER TABLE "BroadcastJob" ADD COLUMN "followUpRollingUntil" TIMESTAMP(3);
