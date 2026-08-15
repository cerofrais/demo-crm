/**
 * =============================================================================
 * One-off: collapse "package:<slug>" tags onto the plain "<slug>" staff use.
 *
 *   npx tsx scripts/merge-package-tags.ts            # dry run
 *   npx tsx scripts/merge-package-tags.ts --apply    # write
 *
 * The first cut of the package-preference feature minted a namespaced
 * "package:mini-detox" tag. Staff had been tagging leads "mini-detox" by hand
 * long before that, so the tag picker ended up showing two identically
 * labelled chips for the same thing. The namespace is gone; this rewrites the
 * rows it already created.
 *
 * Rewrites in place, de-duplicating: a lead carrying both "package:mini-detox"
 * and "mini-detox" ends with just "mini-detox". Also drops the orphaned
 * "package:*" entries from the shared Tag vocabulary.
 *
 * Safe to re-run — once there are no "package:" tags left it reports nothing
 * to do.
 * =============================================================================
 */
import { prisma } from "../src/lib/prisma";

const APPLY = process.argv.includes("--apply");
const PREFIX = "package:";

async function main() {
  console.log(APPLY ? "\nAPPLYING changes\n" : "\nDRY RUN — nothing will be written\n");

  // Every enquiry, soft-deleted ones included — a restored lead would
  // otherwise come back carrying the stale namespaced tag. No `where` filter:
  // Prisma's array operators can't do prefix matching, and id+tags over a few
  // hundred rows is cheap enough to filter in memory.
  const enquiries = await prisma.enquiry.findMany({
    select: { id: true, tags: true, guest: { select: { fullName: true } } },
  });

  let changed = 0;
  let mergedIntoExisting = 0;
  const plainSlugs = new Set<string>();

  for (const e of enquiries) {
    if (!e.tags.some((t) => t.startsWith(PREFIX))) continue;
    for (const t of e.tags) {
      if (t.startsWith(PREFIX)) plainSlugs.add(t.slice(PREFIX.length));
    }
    const next = Array.from(
      new Set(e.tags.map((t) => (t.startsWith(PREFIX) ? t.slice(PREFIX.length) : t))),
    );
    // Shorter than a plain rename means the plain slug was already there and
    // the two collapsed into one — the exact duplication being cleaned up.
    const collapsed = next.length < e.tags.length;
    if (collapsed) mergedIntoExisting++;
    changed++;

    if (APPLY) {
      await prisma.enquiry.update({ where: { id: e.id }, data: { tags: next } });
    } else {
      console.log(
        `  ${e.guest.fullName.padEnd(26).slice(0, 26)} ${e.tags.filter((t) => t.startsWith(PREFIX)).join(",")}` +
          ` -> ${next.filter((t) => !t.includes(":")).join(",")}${collapsed ? "  (merged with existing)" : ""}`,
      );
    }
  }

  const orphanVocab = await prisma.tag.findMany({
    where: { value: { startsWith: PREFIX } },
    select: { value: true },
  });
  if (APPLY && orphanVocab.length) {
    await prisma.tag.deleteMany({ where: { value: { startsWith: PREFIX } } });
  }

  // Vocabulary registration lives in backfill-form-details.ts, which
  // re-derives every package tag on each run and so still catches leads this
  // script has already rewritten. Nothing to do here.
  void plainSlugs;

  console.log(`
  leads rewritten                        : ${changed}
  of those, merged into an existing tag  : ${mergedIntoExisting}
  orphaned vocabulary entries removed    : ${orphanVocab.length}${
    orphanVocab.length ? ` (${orphanVocab.map((t) => t.value).join(", ")})` : ""
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
