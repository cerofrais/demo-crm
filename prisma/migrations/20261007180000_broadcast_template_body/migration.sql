-- Keep the words a template actually said, so a thread does not read
-- "[template: rakhi_2026_1]".
ALTER TABLE "BroadcastJob" ADD COLUMN IF NOT EXISTS "templateBody" TEXT;
