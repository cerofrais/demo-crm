-- Lead sheet check: settings singleton, configured sheets, and run history.
CREATE TABLE "SheetCheckSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "intervalDays" INTEGER NOT NULL DEFAULT 3,
    "recipients" TEXT[] DEFAULT ARRAY['ceo@trewellness.in']::TEXT[],
    "pushMissing" BOOLEAN NOT NULL DEFAULT true,
    "lastTickAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SheetCheckSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SheetCheckSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sheetUrl" TEXT NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "gid" TEXT,
    "campaignLabel" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRowNumber" INTEGER,
    "lastCheckedAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastMessage" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SheetCheckSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SheetCheckRun" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'running',
    "checkedCount" INTEGER NOT NULL DEFAULT 0,
    "missingCount" INTEGER NOT NULL DEFAULT 0,
    "pushedCount" INTEGER NOT NULL DEFAULT 0,
    "pushFailedCount" INTEGER NOT NULL DEFAULT 0,
    "sheetErrors" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB NOT NULL DEFAULT '[]',
    "csvKey" TEXT,
    "csvFilename" TEXT,
    "emailedAt" TIMESTAMP(3),
    "emailedTo" TEXT,
    "emailError" TEXT,
    "error" TEXT,
    "createdBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SheetCheckRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SheetCheckRun_startedAt_idx" ON "SheetCheckRun"("startedAt");
