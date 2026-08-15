/**
 * =============================================================================
 * One-off: move existing follow-up tasks into the LEAD OWNER's queue.
 *
 *   npx tsx scripts/reassign-tasks-to-lead-owner.ts            # dry run
 *   npx tsx scripts/reassign-tasks-to-lead-owner.ts --apply    # write
 *
 * Tasks used to be created with assignedToSub = whoever typed them, so a
 * follow-up an Admin or Manager added on someone else's lead sat in the
 * CREATOR's queue and the person working that lead never saw it. New tasks
 * now go to the lead's owner; this fixes the ones already in the wrong place.
 *
 * Scope, deliberately narrow:
 *   • OPEN tasks only — a completed task is a historical record, and moving
 *     it would rewrite who did the work.
 *   • follow_up only — doctor_review and deletion_approval are unassigned
 *     org-level queues by design, not somebody's personal work.
 *   • only where the lead HAS an owner and it differs from the assignee.
 *
 * createdBy is untouched, so the card keeps showing who asked for it.
 * Safe to re-run — a second pass finds nothing.
 * =============================================================================
 */
import { prisma } from "../src/lib/prisma";

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(APPLY ? "\nAPPLYING changes\n" : "\nDRY RUN — nothing will be written\n");

  const tasks = await prisma.task.findMany({
    where: {
      status: "open",
      kind: "follow_up",
      enquiry: { assignedToSub: { not: null }, deletedAt: null },
    },
    select: {
      id: true,
      title: true,
      assignedToSub: true,
      createdBy: true,
      enquiry: { select: { assignedToSub: true, guest: { select: { fullName: true } } } },
    },
  });

  const misassigned = tasks.filter((t) => t.assignedToSub !== t.enquiry.assignedToSub);

  const staff = await prisma.staffProfile.findMany({
    select: { keycloakId: true, displayName: true },
  });
  const name = (sub: string | null) =>
    sub ? (staff.find((s) => s.keycloakId === sub)?.displayName ?? sub.slice(0, 8)) : "(nobody)";

  const moved = new Map<string, number>();
  for (const t of misassigned) {
    const to = t.enquiry.assignedToSub!;
    moved.set(to, (moved.get(to) ?? 0) + 1);
    if (APPLY) {
      await prisma.task.update({ where: { id: t.id }, data: { assignedToSub: to } });
    } else {
      console.log(
        `  "${t.title.slice(0, 44)}" on ${t.enquiry.guest.fullName}\n` +
          `      ${name(t.assignedToSub)} -> ${name(to)}   (added by ${name(t.createdBy)})`,
      );
    }
  }

  console.log(`\n  open follow-ups checked : ${tasks.length}`);
  console.log(`  moved to the lead owner : ${misassigned.length}`);
  for (const [sub, count] of [...moved].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${name(sub).padEnd(22)} +${count}`);
  }
  console.log();
  if (!APPLY) console.log("  Re-run with --apply to write these changes.\n");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
