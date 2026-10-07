/**
 * =============================================================================
 * Re-sync persisted lead tags where they've fallen behind the computed set.
 *
 *   npx tsx scripts/resync-lead-tags.ts            # dry run, changes nothing
 *   npx tsx scripts/resync-lead-tags.ts --apply    # write
 *
 * Two system tags (`age:*`, `revisit`) are derived from the GUEST, so changing
 * a guest's date of birth or returning flag invalidates the tags stored on
 * their leads. Leads keep DISPLAYING the right tags (toEnquiryDTO merges on
 * read), but the persisted column — the one tag filters query — drifts, and a
 * lead stops matching a filter for a tag it visibly carries.
 *
 * The guest-update route now re-syncs on its own (see syncTagsForGuest); this
 * is the one-off catch-up for drift that accumulated before it did, notably
 * from backfill-form-details.ts writing dateOfBirth directly.
 * =============================================================================
 */
import { prisma } from "../src/lib/prisma";
import { mergeLeadTags } from "../src/lib/lead-tags";

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(APPLY ? "\nAPPLYING changes\n" : "\nDRY RUN — nothing will be written\n");

  const enquiries = await prisma.enquiry.findMany({
    where: { deletedAt: null },
    include: { guest: true },
  });

  let drifted = 0;
  const added = new Map<string, number>();

  for (const e of enquiries) {
    const merged = mergeLeadTags(e.tags, e.guest, e);
    const persisted = new Set(e.tags);
    const missing = merged.filter((t) => !persisted.has(t));
    // Only ADDITIVE drift is repaired here. A tag in the column but not in
    // the merged set is a custom tag (mergeLeadTags keeps those) or a stale
    // system tag that mergeLeadTags itself drops — either way `merged` is
    // authoritative, so writing it wholesale is correct.
    const same = merged.length === e.tags.length && merged.every((t) => persisted.has(t));
    if (same) continue;

    drifted++;
    for (const m of missing) added.set(m, (added.get(m) ?? 0) + 1);
    if (APPLY) {
      await prisma.enquiry.update({ where: { id: e.id }, data: { tags: merged } });
    } else if (drifted <= 10) {
      console.log(`  ${e.guest.fullName.padEnd(26).slice(0, 26)} [${e.tags}] -> [${merged}]`);
    }
  }

  console.log(`
  leads scanned  : ${enquiries.length}
  leads re-synced: ${drifted}
  tags restored  : ${JSON.stringify(Object.fromEntries([...added].sort((a, b) => b[1] - a[1])))}
`);
  if (!APPLY) console.log("  Re-run with --apply to write these changes.\n");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
