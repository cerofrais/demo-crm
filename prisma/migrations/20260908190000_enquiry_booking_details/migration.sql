-- CreateEnum
CREATE TYPE "Occupancy" AS ENUM ('single', 'double');

-- CreateEnum
CREATE TYPE "RoomCategory" AS ENUM ('premium', 'executive');

-- AlterTable
-- All nullable with no default: every existing lead keeps no booking detail,
-- which is the correct reading of "we never asked".
ALTER TABLE "Enquiry"
    ADD COLUMN "occupancy" "Occupancy",
    ADD COLUMN "companionName" TEXT,
    ADD COLUMN "stayDays" INTEGER,
    ADD COLUMN "pricePerDayINR" INTEGER,
    ADD COLUMN "roomCategory" "RoomCategory";
