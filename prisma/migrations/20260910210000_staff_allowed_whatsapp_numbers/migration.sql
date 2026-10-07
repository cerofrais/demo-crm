-- Which WhatsApp lines a staff member may send from. Empty = unrestricted,
-- so every existing user keeps exactly the access they have today.
ALTER TABLE "StaffProfile" ADD COLUMN "allowedWhatsAppNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[];
