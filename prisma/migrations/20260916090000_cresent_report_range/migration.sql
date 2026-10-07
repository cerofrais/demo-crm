-- Cresent report sends can cover any range of days, not only a week.
ALTER TABLE "CresentReport" ADD COLUMN "rangeEnd" DATE;
