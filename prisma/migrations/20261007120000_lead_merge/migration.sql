-- A record of what each merge moved, so a merge can be undone.
CREATE TABLE IF NOT EXISTS "LeadMerge" (
  "id" TEXT NOT NULL,
  "targetEnquiryId" TEXT NOT NULL,
  "sourceEnquiryId" TEXT NOT NULL,
  "targetGuestId" TEXT NOT NULL,
  "sourceGuestId" TEXT NOT NULL,
  "movedMessageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "movedCallIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "movedNoteIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "movedTaskIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "movedDocumentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "movedActivityIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "movedAiDecisionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "movedMembershipIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "movedHealthProfileIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "guestFieldsMoved" JSONB NOT NULL DEFAULT '{}',
  "undoneAt" TIMESTAMP(3),
  "undoneBySub" TEXT,
  "mergedBySub" TEXT NOT NULL,
  "mergedByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadMerge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LeadMerge_targetEnquiryId_idx" ON "LeadMerge"("targetEnquiryId");
CREATE INDEX IF NOT EXISTS "LeadMerge_sourceEnquiryId_idx" ON "LeadMerge"("sourceEnquiryId");
