-- AI feature fields (call analysis, lead scoring, guest insights)

ALTER TABLE "Call"
  ADD COLUMN "transcript"    TEXT,
  ADD COLUMN "aiSummary"     TEXT,
  ADD COLUMN "aiScore"       INTEGER,
  ADD COLUMN "aiTags"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "aiSuggestions" JSONB,
  ADD COLUMN "aiAnalyzedAt"  TIMESTAMP(3);

ALTER TABLE "Enquiry"
  ADD COLUMN "aiScore"       INTEGER,
  ADD COLUMN "aiScoreReason" TEXT,
  ADD COLUMN "aiScoredAt"    TIMESTAMP(3);

ALTER TABLE "Guest"
  ADD COLUMN "aiReturnScore"  INTEGER,
  ADD COLUMN "aiReturnReason" TEXT,
  ADD COLUMN "aiNextProgram"  TEXT,
  ADD COLUMN "aiInsightAt"    TIMESTAMP(3);
