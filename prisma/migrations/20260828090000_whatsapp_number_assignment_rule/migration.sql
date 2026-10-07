-- CreateTable
CREATE TABLE "WhatsAppNumberAssignmentRule" (
    "ourNumber" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "strategy" "LeadAssignmentStrategy" NOT NULL DEFAULT 'round_robin',
    "eligibleSubs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppNumberAssignmentRule_pkey" PRIMARY KEY ("ourNumber")
);
