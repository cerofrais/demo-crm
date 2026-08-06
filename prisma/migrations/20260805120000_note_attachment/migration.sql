-- Voice note / file attachment on a remark (Note.attachmentDocumentId),
-- reusing the Document/storage pipeline already used for Message
-- attachments. SetNull (not the default Restrict) so a guest hard-delete's
-- Document cleanup — which runs before the Enquiry cascade that removes
-- Notes — never trips a FK violation here.
ALTER TABLE "Note" ADD COLUMN "attachmentDocumentId" TEXT;

ALTER TABLE "Note" ADD CONSTRAINT "Note_attachmentDocumentId_fkey"
    FOREIGN KEY ("attachmentDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
