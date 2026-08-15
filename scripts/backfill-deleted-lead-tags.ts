/**
 * =============================================================================
 * Backfill stale system tags (revisit/source/age/campaign) on already
 * soft-deleted leads.
 *
 *   npx tsx scripts/backfill-deleted-lead-tags.ts            # dry run
 *   npx tsx scripts/backfill-deleted-lead-tags.ts --apply    # write
 *
 * syncEnquiryTags() only ran when a salesperson touched a lead — create,
 * move, edit. A lead that was soft-deleted (manually, or by the Lost/Dead
 * auto-delete sweep) without ever being touched after its system tags last
 * changed carries a persisted `tags` column that's missing them, most
 * commonly "revisit" for a returning guest whose card sat untouched in
 * Lost until the sweep caught it. The Deleted Leads archive's tag filter —
 * and the archive's DB-level `hasEvery` matching, not just the filter's
 * option list — reads that column directly, so a stale row silently can't
 * be found by the tag it actually should carry.
 *
 * This recomputes each deleted lead's tags the same way syncEnquiryTags
 * does and only writes rows where the result actually differs — custom tags
 * are untouched either way (mergeLeadTags always keeps them).
 * =============================================================================
 */
import { prisma } from "../src/lib/prisma";
import { mergeLeadTags } from "../src/lib/lead-tags";

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(APPLY ? "\nAPPLYING changes\n" : "\nDRY RUN — nothing will be written\n");

  const rows = await prisma.enquiry.findMany({
    where: { deletedAt: { not: null } },
    select: {
      id: true,
      tags: true,
      source: true,
      campaignLabel: true,
      isReturningFlag: true,
      guest: { select: { fullName: true, dateOfBirth: true, isReturning: true, phone: true } },
    },
  });

  let scanned = 0;
  let changed = 0;
  const addedByTag = new Map<string, number>();

  for (const e of rows) {
    scanned++;
    const merged = mergeLeadTags(e.tags, e.guest, e);
    const same = merged.length === e.tags.length && merged.every((t) => e.tags.includes(t));
    if (same) continue;

    changed++;
    const added = merged.filter((t) => !e.tags.includes(t));
    for (const t of added) addedByTag.set(t, (addedByTag.get(t) ?? 0) + 1);

    console.log(`  ${e.guest.fullName.padEnd(26).slice(0, 26)}  +${added.join(", +")}`);

    if (APPLY) {
      await prisma.enquiry.update({ where: { id: e.id }, data: { tags: merged } });
    }
  }

  console.log(`
  deleted leads scanned : ${scanned}
  leads with stale tags : ${changed}
  tags added, by kind    : ${
    addedByTag.size
      ? [...addedByTag.entries()].map(([t, n]) => `${t}=${n}`).join(", ")
      : "(none)"
  }
`);
  if (!APPLY) console.log("  Re-run with --apply to write these changes.\n");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
