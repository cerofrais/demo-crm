-- Weekly Cresent report: settings singleton and a send log.
CREATE TABLE "CresentReportSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CresentReportSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CresentReport" (
    "id" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "scheduledWeek" DATE,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "emailedAt" TIMESTAMP(3),
    "emailedTo" TEXT,
    "emailError" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CresentReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CresentReport_scheduledWeek_key" ON "CresentReport"("scheduledWeek");
CREATE INDEX "CresentReport_weekStart_idx" ON "CresentReport"("weekStart");
