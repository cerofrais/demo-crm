-- Folders for message templates: free text, null = unfiled.
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "folder" TEXT;
CREATE INDEX IF NOT EXISTS "MessageTemplate_channel_folder_idx" ON "MessageTemplate"("channel", "folder");

-- Remarks drafted by the model from a photo, a voice note or typed shorthand.
ALTER TYPE "AiDecisionKind" ADD VALUE IF NOT EXISTS 'remark_draft';
