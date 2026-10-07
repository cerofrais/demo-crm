-- A board column for submissions that were never a lead: spam, vendors,
-- wrong numbers, internal mail. Distinct from `lost`, which is a real
-- enquiry that did not convert — mixing the two makes every conversion
-- figure read worse than reality.
--
-- BEFORE 'lost' so the enum's own order matches the board's.
ALTER TYPE "EnquiryStage" ADD VALUE 'non_leads' BEFORE 'lost';
