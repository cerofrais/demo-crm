-- Optional attachment on an auto-reply (WhatsApp) and on the welcome email.
-- Library documents only (no guest/enquiry scope) — one asset is sent to
-- every guest the rule fires for, same constraint as a broadcast attachment.

ALTER TABLE "AutoReply" ADD COLUMN "attachmentDocumentId" TEXT;
ALTER TABLE "WelcomeEmailSetting" ADD COLUMN "attachmentDocumentId" TEXT;

ALTER TABLE "AutoReply" ADD CONSTRAINT "AutoReply_attachmentDocumentId_fkey"
  FOREIGN KEY ("attachmentDocumentId") REFERENCES "Document"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WelcomeEmailSetting" ADD CONSTRAINT "WelcomeEmailSetting_attachmentDocumentId_fkey"
  FOREIGN KEY ("attachmentDocumentId") REFERENCES "Document"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
