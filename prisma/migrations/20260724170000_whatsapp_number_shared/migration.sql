-- Per-number "shared" toggle: admin can hide a connected WhatsApp number
-- from staff send-from pickers (dropdown, broadcast, own-number default)
-- without disconnecting it, for scaling down how many of many connected
-- numbers are actually offered to staff.
ALTER TABLE "WhatsAppNumber" ADD COLUMN "shared" BOOLEAN NOT NULL DEFAULT true;
