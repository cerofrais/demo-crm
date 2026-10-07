-- Tag a lead automatically when an inbound email's subject or body matches.
-- Email sibling of AutoTag; matched like EmailAutoReply.
CREATE TABLE "EmailAutoTag" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL DEFAULT 'sales',
    "subjectTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bodyTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "termMatch" TEXT NOT NULL DEFAULT 'any',
    "tag" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailAutoTag_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailAutoTag_mailboxId_enabled_idx" ON "EmailAutoTag"("mailboxId", "enabled");
