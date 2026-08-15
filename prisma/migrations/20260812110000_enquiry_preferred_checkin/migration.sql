-- The check-in date a guest asked for on the website enquiry form. Previously
-- parsed out of the form email and left in intakeNotes free text only.
ALTER TABLE "Enquiry" ADD COLUMN "preferredCheckIn" TIMESTAMP(3);
