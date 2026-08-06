-- AI/ML decision audit log — one row per LLM inference, with the exact
-- prompt sent and the exact structured output received, kept even after
-- Call/Enquiry/Guest.ai* fields are overwritten by a later run.

CREATE TYPE "AiDecisionKind" AS ENUM ('call_analysis', 'lead_scoring', 'guest_insight', 'conversation_assist');

CREATE TABLE "AiDecision" (
    "id"              TEXT NOT NULL,
    "kind"            "AiDecisionKind" NOT NULL,
    "callId"          TEXT,
    "enquiryId"       TEXT,
    "guestId"         TEXT,
    "provider"        TEXT NOT NULL,
    "model"           TEXT NOT NULL,
    "promptSystem"    TEXT NOT NULL,
    "promptUser"      TEXT NOT NULL,
    "output"          JSONB,
    "success"         BOOLEAN NOT NULL DEFAULT true,
    "errorMessage"    TEXT,
    "durationMs"      INTEGER,
    "triggeredBy"     TEXT,
    "triggeredByName" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiDecision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiDecision_kind_createdAt_idx" ON "AiDecision"("kind", "createdAt");
CREATE INDEX "AiDecision_callId_idx" ON "AiDecision"("callId");
CREATE INDEX "AiDecision_enquiryId_idx" ON "AiDecision"("enquiryId");
CREATE INDEX "AiDecision_guestId_idx" ON "AiDecision"("guestId");

ALTER TABLE "AiDecision" ADD CONSTRAINT "AiDecision_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiDecision" ADD CONSTRAINT "AiDecision_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "Enquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiDecision" ADD CONSTRAINT "AiDecision_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
