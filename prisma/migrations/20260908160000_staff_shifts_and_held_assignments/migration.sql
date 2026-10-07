-- CreateTable
CREATE TABLE "StaffShift" (
    "id" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,

    CONSTRAINT "StaffShift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffShift_sub_weekday_key" ON "StaffShift"("sub", "weekday");
CREATE INDEX "StaffShift_sub_idx" ON "StaffShift"("sub");

-- CreateTable
CREATE TABLE "HeldAssignment" (
    "enquiryId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "campaignLabel" TEXT,
    "ourWhatsAppNumber" TEXT,
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "HeldAssignment_pkey" PRIMARY KEY ("enquiryId")
);

-- CreateIndex
CREATE INDEX "HeldAssignment_heldAt_idx" ON "HeldAssignment"("heldAt");
