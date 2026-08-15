-- Custom-range marketing reports, generated on demand alongside the scheduled
-- daily ones. reportDate becomes nullable so a custom range doesn't occupy a
-- calendar day's unique slot (Postgres permits many NULLs under a unique
-- index); rangeStart/rangeEnd record the window actually covered.
ALTER TABLE "MarketingReport" ALTER COLUMN "reportDate" DROP NOT NULL;

-- Backfill the new columns from the existing reportDate before enforcing NOT
-- NULL: an already-generated daily report covers exactly its own IST day
-- (00:00 IST = 18:30 UTC the previous day).
ALTER TABLE "MarketingReport" ADD COLUMN "rangeStart" TIMESTAMP(3);
ALTER TABLE "MarketingReport" ADD COLUMN "rangeEnd" TIMESTAMP(3);

UPDATE "MarketingReport"
SET "rangeStart" = "reportDate"::timestamp - INTERVAL '5 hours 30 minutes',
    "rangeEnd"   = "reportDate"::timestamp + INTERVAL '18 hours 29 minutes 59 seconds'
WHERE "rangeStart" IS NULL;

ALTER TABLE "MarketingReport" ALTER COLUMN "rangeStart" SET NOT NULL;
ALTER TABLE "MarketingReport" ALTER COLUMN "rangeEnd" SET NOT NULL;
