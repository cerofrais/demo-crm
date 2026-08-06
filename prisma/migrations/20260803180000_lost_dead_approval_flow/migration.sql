-- Reinstate the deletion-approval task flow: moving a lead to Lost/Dead is
-- now request-only for everyone (see the enquiries/[id]/stage and
-- enquiries/[id]/route.ts guards), decided via PATCH /api/tasks/:id/decision.
ALTER TYPE "TaskKind" ADD VALUE 'deletion_approval';

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "approved" BOOLEAN;
