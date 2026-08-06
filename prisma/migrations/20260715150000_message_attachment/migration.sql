-- Inline media on a message (WhatsApp images/audio/documents) — links to the
-- same Document row already used by the Documents tab / email attachments.

ALTER TABLE "Message" ADD COLUMN "attachmentDocumentId" TEXT;

ALTER TABLE "Message" ADD CONSTRAINT "Message_attachmentDocumentId_fkey" FOREIGN KEY ("attachmentDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
