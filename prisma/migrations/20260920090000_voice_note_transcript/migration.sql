-- Speech-to-text for WhatsApp voice notes, stored on the message itself
-- (same shape as Call.transcript / Call.transcriptEnglish).
ALTER TABLE "Message" ADD COLUMN "transcript" TEXT;
ALTER TABLE "Message" ADD COLUMN "transcriptEnglish" TEXT;
ALTER TABLE "Message" ADD COLUMN "transcriptLanguage" TEXT;
ALTER TABLE "Message" ADD COLUMN "transcribedAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN "transcriptError" TEXT;
ALTER TABLE "Message" ADD COLUMN "transcriptAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Message" ADD COLUMN "transcriptAttemptAt" TIMESTAMP(3);

-- The background sweep's lookup: audio messages still awaiting a transcript.
CREATE INDEX "Message_channel_transcribedAt_createdAt_idx"
  ON "Message"("channel", "transcribedAt", "createdAt");
