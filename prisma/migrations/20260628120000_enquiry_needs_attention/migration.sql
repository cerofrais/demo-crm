-- AddColumn: Enquiry.needsAttention
-- Set when an inbound email or follow-up task arrives; cleared when a rep opens the lead drawer.
ALTER TABLE "Enquiry" ADD COLUMN "needsAttention" BOOLEAN NOT NULL DEFAULT FALSE;
