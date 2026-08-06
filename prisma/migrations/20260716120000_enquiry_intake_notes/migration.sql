-- Free-text intake notes on a lead (e.g. lead-gen form Q&A) — a single
-- optional field, separate from the Note[] remarks timeline.

ALTER TABLE "Enquiry" ADD COLUMN "intakeNotes" TEXT;
