-- Multi-language transcription: store the reconciled native transcript's
-- English translation and detected language alongside it, and add a new
-- AiDecision kind to audit the reconciliation/translation step.

ALTER TABLE "Call" ADD COLUMN "transcriptEnglish" TEXT;
ALTER TABLE "Call" ADD COLUMN "transcriptLanguage" TEXT;

ALTER TYPE "AiDecisionKind" ADD VALUE 'transcript_translation';
