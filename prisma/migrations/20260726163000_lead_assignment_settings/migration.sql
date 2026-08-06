-- Per-channel control over who a freshly auto-created lead gets assigned to
-- (WhatsApp / email / call). Empty eligibleSubs = not configured, falls back
-- to each channel's existing default assignment pool.
CREATE TYPE "LeadAssignmentCategory" AS ENUM ('whatsapp', 'email', 'call');
CREATE TYPE "LeadAssignmentStrategy" AS ENUM ('round_robin', 'least_busy');

CREATE TABLE "LeadAssignmentSettings" (
    "category" "LeadAssignmentCategory" NOT NULL,
    "strategy" "LeadAssignmentStrategy" NOT NULL DEFAULT 'round_robin',
    "eligibleSubs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadAssignmentSettings_pkey" PRIMARY KEY ("category")
);
