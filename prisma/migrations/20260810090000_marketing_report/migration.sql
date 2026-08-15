-- Daily marketing CSV index. The file lives in object storage; this table is
-- what the Reports > Marketing page lists and how we know whether a given
-- day's report actually reached the CEO.
CREATE TABLE "MarketingReport" (
    "id" TEXT NOT NULL,
    "reportDate" DATE NOT NULL,
    "filename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emailedAt" TIMESTAMP(3),
    "emailedTo" TEXT,
    "emailError" TEXT,
    CONSTRAINT "MarketingReport_pkey" PRIMARY KEY ("id")
);

-- One report per covered day: a re-run replaces that day's file.
CREATE UNIQUE INDEX "MarketingReport_reportDate_key" ON "MarketingReport"("reportDate");
CREATE INDEX "MarketingReport_reportDate_idx" ON "MarketingReport"("reportDate");
