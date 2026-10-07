-- Cap and explain call transcription, so an undecodable recording stops being
-- re-queued forever (it was holding every slot in the 5-per-tick pass).
ALTER TABLE "Call" ADD COLUMN "transcriptAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Call" ADD COLUMN "transcriptAttemptAt" TIMESTAMP(3);
ALTER TABLE "Call" ADD COLUMN "transcriptError" TEXT;

-- Calls already analysed with a recording but no transcript have each been
-- retried hundreds of times. Start them at the cap so the queue drains to the
-- work that has never been looked at; an operator can reset a specific call.
UPDATE "Call"
SET "transcriptAttempts" = 3,
    "transcriptError" = CASE
      WHEN status = 'no_answer' THEN 'the call was never answered — the recording is ringing only'
      ELSE 'no speech was recognised in the recording'
    END
WHERE "aiAnalyzedAt" IS NOT NULL
  AND "recordingUrl" IS NOT NULL
  AND "transcriptEnglish" IS NULL;

-- The retry pass's lookup.
CREATE INDEX "Call_status_aiAnalyzedAt_transcriptAttempts_idx"
  ON "Call"("status", "aiAnalyzedAt", "transcriptAttempts");
