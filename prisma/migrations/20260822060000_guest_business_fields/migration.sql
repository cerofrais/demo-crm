-- Business name and role on a guest, for lead forms that collect them.
-- Both nullable: every existing guest simply has neither.
ALTER TABLE "Guest" ADD COLUMN "businessName" TEXT;
ALTER TABLE "Guest" ADD COLUMN "businessRole" TEXT;
