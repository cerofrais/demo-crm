-- Inbound call routing grows from a Reception-only on/off switch to four
-- scopes (reception / sales / reception_sales / all) so an admin can route
-- calls to Sales too, not just Reception.
CREATE TYPE "CallRoutingScope" AS ENUM ('reception', 'sales', 'reception_sales', 'all');

ALTER TABLE "CallRoutingSettings" ADD COLUMN "scope" "CallRoutingScope" NOT NULL DEFAULT 'reception';

-- Backfill from the old boolean: true -> reception (same effective scope),
-- false -> all (the old "off" behavior routed to any online staff).
UPDATE "CallRoutingSettings" SET "scope" = CASE WHEN "receptionOnly" THEN 'reception' ELSE 'all' END::"CallRoutingScope";

ALTER TABLE "CallRoutingSettings" DROP COLUMN "receptionOnly";
