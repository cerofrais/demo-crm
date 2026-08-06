-- Persist the AI Assist result on the lead so it survives drawer close/reopen
-- and only regenerates when the rep explicitly requests it.

ALTER TABLE "Enquiry" ADD COLUMN "aiAssist" JSONB;
ALTER TABLE "Enquiry" ADD COLUMN "aiAssistAt" TIMESTAMP(3);
