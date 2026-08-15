-- CreateTable
CREATE TABLE "CampaignAssignmentRule" (
    "campaignSlug" TEXT NOT NULL,
    "campaignLabel" TEXT NOT NULL,
    "strategy" "LeadAssignmentStrategy" NOT NULL DEFAULT 'round_robin',
    "eligibleSubs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignAssignmentRule_pkey" PRIMARY KEY ("campaignSlug")
);
