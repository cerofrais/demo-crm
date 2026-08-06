-- Soft-delete for lead tickets (admin only). No cascade — Notes/Tasks/
-- Messages/Calls/AiDecisions tied to the enquiry are kept, just no longer
-- reachable from a deleted ticket. Same convention as Guest.deletedAt.

ALTER TABLE "Enquiry" ADD COLUMN "deletedAt" TIMESTAMP(3);
