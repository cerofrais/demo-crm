-- AlterTable
ALTER TABLE "StaffProfile" ADD COLUMN "weeklyOffDays" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];

-- CreateTable
CREATE TABLE "StaffLeave" (
    "id" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffLeave_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffLeave_sub_startDate_endDate_idx" ON "StaffLeave"("sub", "startDate", "endDate");
