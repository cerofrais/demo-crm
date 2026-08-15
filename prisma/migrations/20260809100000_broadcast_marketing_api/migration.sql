-- Marketing Messages API (MM Lite) routing for broadcasts.
-- templateCategory is resolved from Meta at job-creation time and decides
-- which send endpoint the job uses; usedMarketingApi records which endpoint
-- it actually went out over, so the two paths' delivery can be compared
-- later even after the env kill-switch is flipped.
ALTER TABLE "BroadcastJob" ADD COLUMN "templateCategory" TEXT;
ALTER TABLE "BroadcastJob" ADD COLUMN "usedMarketingApi" BOOLEAN NOT NULL DEFAULT false;
