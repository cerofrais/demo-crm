-- CreateTable
CREATE TABLE "TagAssignmentRule" (
    "tag" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "strategy" "LeadAssignmentStrategy" NOT NULL DEFAULT 'round_robin',
    "eligibleSubs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "priority" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TagAssignmentRule_pkey" PRIMARY KEY ("tag")
);

-- CreateIndex
CREATE INDEX "TagAssignmentRule_priority_idx" ON "TagAssignmentRule"("priority");

-- AlterTable
-- A held lead has to replay the SAME routing inputs it arrived with, tags
-- included, or a delayed lead would be assigned differently from an immediate one.
ALTER TABLE "HeldAssignment" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
