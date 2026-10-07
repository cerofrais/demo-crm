/**
 * Open the standing Payment Pending chase on leads already sitting in that
 * column.
 *
 * Going forward the task is created when a lead ENTERS the stage (see the
 * stage-transition route), so this only covers the ones that got there before
 * the feature existed and would otherwise never get one.
 *
 * Idempotent by the same rule as the live path — a lead with an open
 * payment_pending task is skipped — so a re-run adds nothing.
 *
 *   npx tsx scripts/backfill-payment-pending-tasks.ts          # report only
 *   npx tsx scripts/backfill-payment-pending-tasks.ts --apply  # do it
 */
import { PrismaClient } from "@prisma/client";
import { PAYMENT_PENDING_TITLE_PREFIX, nextEightAmIst } from "../src/lib/tasks";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const leads = await prisma.enquiry.findMany({
    where: {
      stage: "payment_received",
      deletedAt: null,
      // Skip anything that already has one, so this can be re-run safely.
      tasks: { none: { status: "open", kind: "payment_pending" } },
    },
    select: {
      id: true,
      assignedToSub: true,
      assignedToName: true,
      guest: { select: { fullName: true } },
    },
    orderBy: { lastActivityAt: "asc" },
  });

  if (!leads.length) {
    console.log("Nothing to do — every Payment Pending lead already has an open chase.");
    return;
  }

  const dueAt = nextEightAmIst();
  console.log(`${leads.length} lead(s) in Payment Pending with no chase. Due ${dueAt.toISOString()} (08:00 IST).\n`);
  for (const l of leads) {
    console.log(`  ${APPLY ? "FIX " : "PLAN"}  ${l.guest.fullName} -> ${l.assignedToName ?? "(unassigned)"}`);
  }

  if (!APPLY) {
    console.log(`\nWould open ${leads.length} task(s). Re-run with --apply.`);
    return;
  }

  // createMany, not the live helper: the "already has one" check is in the
  // query above and this is a single statement rather than N round trips.
  const { count } = await prisma.task.createMany({
    data: leads.map((l) => ({
      enquiryId: l.id,
      title: `${PAYMENT_PENDING_TITLE_PREFIX}${l.guest.fullName}`,
      kind: "payment_pending" as const,
      dueAt,
      // Unassigned stays unassigned — it surfaces under Tasks -> All staff
      // rather than being given an owner the lead does not have.
      assignedToSub: l.assignedToSub,
      createdBy: "system",
    })),
  });
  console.log(`\nOpened ${count} task(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
