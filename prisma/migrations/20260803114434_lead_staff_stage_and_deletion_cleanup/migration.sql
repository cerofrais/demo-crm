-- Remove the deletion-approval task flow entirely (superseded by a plain
-- time-based auto-delete sweep off Enquiry.lostAt) before touching TaskKind,
-- so no existing row is left referencing a value about to be dropped.
DELETE FROM "Task" WHERE "kind" = 'deletion_approval';

-- New "staff" kanban stage — a catch-all parking column just before Lost/Dead.
-- Ordinal position within the enum doesn't affect app behavior (column order
-- comes from the STAGES array in src/lib/kanban.ts), so a plain append is fine.
ALTER TYPE "EnquiryStage" ADD VALUE 'staff';

-- AlterEnum
BEGIN;
CREATE TYPE "TaskKind_new" AS ENUM ('follow_up', 'doctor_review');
ALTER TABLE "Task" ALTER COLUMN "kind" DROP DEFAULT;
ALTER TABLE "Task" ALTER COLUMN "kind" TYPE "TaskKind_new" USING ("kind"::text::"TaskKind_new");
ALTER TYPE "TaskKind" RENAME TO "TaskKind_old";
ALTER TYPE "TaskKind_new" RENAME TO "TaskKind";
DROP TYPE "TaskKind_old";
ALTER TABLE "Task" ALTER COLUMN "kind" SET DEFAULT 'follow_up';
COMMIT;

-- AlterTable
-- deletionApprovedAt is replaced by lostAt, stamped the moment a lead enters
-- "lost" (see the stage-transition route) — deliberately left NULL for leads
-- already sitting in "lost" today, so they are not swept up retroactively.
ALTER TABLE "Enquiry" DROP COLUMN "deletionApprovedAt",
ADD COLUMN     "lostAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Task" DROP COLUMN "approved";
