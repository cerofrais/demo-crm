/**
 * Collapse duplicate Resources-library files down to one row per filename.
 *
 * The library accumulated 79 rows for 9 distinct files, because every
 * broadcast that attached an image re-uploaded it: 34 identical copies of one
 * Rakshabandhan artwork, 25 of the Independence Day one, 14 of a WhatsApp
 * photo. /api/files/confirm now refuses a same-name upload unless it is an
 * explicit replace, so this only has to clean up what came before it.
 *
 * The keeper is the OLDEST row of each name — the original — and every
 * reference to a duplicate is repointed at it before the duplicate goes.
 * Documents are pointed at from five places (Message, BroadcastJob,
 * AutoReply, WelcomeEmailSetting, Note); missing one would leave a broadcast
 * or an auto-reply pointing at a row that no longer exists.
 *
 * Storage objects are deliberately LEFT IN PLACE. The rows are what the
 * library shows, and orphaning ~31MB is cheap next to deleting live bytes on
 * a wrong assumption. Sweep them separately once this has settled.
 *
 * Only collapses names whose copies are genuinely the same file — identical
 * size AND identical mime type. Anything else is reported and skipped, since
 * two different files sharing a name is a judgement call for a human.
 *
 *   npx tsx scripts/dedupe-library-documents.ts          # report only
 *   npx tsx scripts/dedupe-library-documents.ts --apply  # do it
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const docs = await prisma.document.findMany({
    where: { guestId: null, enquiryId: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, filename: true, sizeBytes: true, mimeType: true, storageKey: true },
  });

  const byName = new Map<string, typeof docs>();
  for (const d of docs) {
    byName.set(d.filename, [...(byName.get(d.filename) ?? []), d]);
  }

  let collapsed = 0;
  let removed = 0;

  for (const [filename, copies] of byName) {
    if (copies.length < 2) continue;

    const [keeper, ...surplus] = copies;
    const uniform = copies.every(
      (c) => c.sizeBytes === keeper.sizeBytes && c.mimeType === keeper.mimeType,
    );
    if (!uniform) {
      console.log(`SKIP  ${filename} — ${copies.length} copies differ in size or type; needs a human`);
      continue;
    }

    const ids = surplus.map((s) => s.id);
    console.log(`${APPLY ? "FIX " : "PLAN"}  ${filename} — keep 1, drop ${ids.length}`);

    if (!APPLY) {
      collapsed++;
      removed += ids.length;
      continue;
    }

    // Repoint first, delete second, in ONE transaction: a half-applied run
    // would leave a broadcast pointing at a deleted document.
    await prisma.$transaction([
      prisma.message.updateMany({
        where: { attachmentDocumentId: { in: ids } },
        data: { attachmentDocumentId: keeper.id },
      }),
      prisma.broadcastJob.updateMany({
        where: { imageDocumentId: { in: ids } },
        data: { imageDocumentId: keeper.id },
      }),
      prisma.autoReply.updateMany({
        where: { attachmentDocumentId: { in: ids } },
        data: { attachmentDocumentId: keeper.id },
      }),
      prisma.welcomeEmailSetting.updateMany({
        where: { attachmentDocumentId: { in: ids } },
        data: { attachmentDocumentId: keeper.id },
      }),
      prisma.note.updateMany({
        where: { attachmentDocumentId: { in: ids } },
        data: { attachmentDocumentId: keeper.id },
      }),
      prisma.document.deleteMany({ where: { id: { in: ids } } }),
    ]);

    collapsed++;
    removed += ids.length;
  }

  const verb = APPLY ? "Collapsed" : "Would collapse";
  console.log(`\n${verb} ${collapsed} filename(s), removing ${removed} duplicate row(s).`);
  if (!APPLY) console.log("Re-run with --apply to make the change.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
