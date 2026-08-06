-- New pipeline stage: payment collected, before booking is confirmed.
ALTER TYPE "EnquiryStage" ADD VALUE 'payment_received';

-- Distinguishes system-generated action-required tasks (deletion approval,
-- doctor review) from ordinary follow-ups, without overloading TaskStatus.
CREATE TYPE "TaskKind" AS ENUM ('follow_up', 'deletion_approval', 'doctor_review');

-- Doctor's Accept/Reject/Needs-phone-consult call on a consultation-stage lead.
CREATE TYPE "DoctorDecision" AS ENUM ('accepted', 'rejected', 'needs_phone_consult');

CREATE TYPE "BroadcastStatus" AS ENUM ('queued', 'running', 'completed', 'cancelled', 'failed');

ALTER TABLE "Task" ADD COLUMN "kind" "TaskKind" NOT NULL DEFAULT 'follow_up';
ALTER TABLE "Task" ADD COLUMN "approved" BOOLEAN;

ALTER TABLE "Enquiry" ADD COLUMN "deletionApprovedAt" TIMESTAMP(3);
ALTER TABLE "Enquiry" ADD COLUMN "doctorDecision" "DoctorDecision";
ALTER TABLE "Enquiry" ADD COLUMN "doctorDecisionAt" TIMESTAMP(3);
ALTER TABLE "Enquiry" ADD COLUMN "doctorDecisionBySub" TEXT;
ALTER TABLE "Enquiry" ADD COLUMN "doctorDecisionNote" TEXT;

-- CRM-side correction/redaction tag on a message record — never touches
-- WhatsApp itself, just flags the local copy for staff visibility.
ALTER TABLE "Message" ADD COLUMN "editedAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN "editedBySub" TEXT;
ALTER TABLE "Message" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN "deletedBySub" TEXT;

-- How many days after manager approval a Dead lead sits before the
-- background sweep soft-deletes it. Admin-configurable (Users page).
CREATE TABLE "LeadDeletionSettings" (
    "id"             TEXT NOT NULL DEFAULT 'singleton',
    "autoDeleteDays" INTEGER NOT NULL DEFAULT 30,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadDeletionSettings_pkey" PRIMARY KEY ("id")
);

-- Round-robin cursor for automatic new-lead assignment.
CREATE TABLE "LeadRoutingState" (
    "id"              TEXT NOT NULL DEFAULT 'singleton',
    "lastAssignedSub" TEXT,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadRoutingState_pkey" PRIMARY KEY ("id")
);

-- Bulk WhatsApp broadcast — one active job at a time, paced in the background.
CREATE TABLE "BroadcastJob" (
    "id"              TEXT NOT NULL,
    "status"          "BroadcastStatus" NOT NULL DEFAULT 'queued',
    "createdBySub"    TEXT NOT NULL,
    "message"         TEXT NOT NULL,
    "imageDocumentId" TEXT,
    "numberId"        TEXT,
    "delaySec"        INTEGER NOT NULL DEFAULT 3,
    "guestIds"        TEXT[],
    "totalCount"      INTEGER NOT NULL,
    "sentCount"       INTEGER NOT NULL DEFAULT 0,
    "failedCount"     INTEGER NOT NULL DEFAULT 0,
    "cursor"          INTEGER NOT NULL DEFAULT 0,
    "errors"          JSONB NOT NULL DEFAULT '[]',
    "lastSentAt"      TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"     TIMESTAMP(3),

    CONSTRAINT "BroadcastJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BroadcastJob_status_idx" ON "BroadcastJob"("status");
