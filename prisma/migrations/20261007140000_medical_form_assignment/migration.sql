-- Pre-arrival (medical screening) forms become their own assignment rule, so
-- they can go to Front Office without re-routing every email enquiry.
ALTER TYPE "LeadAssignmentCategory" ADD VALUE IF NOT EXISTS 'medical_form';

ALTER TABLE "LeadAssignmentSettings"
  ADD COLUMN IF NOT EXISTS "reassignExisting" BOOLEAN NOT NULL DEFAULT false;
