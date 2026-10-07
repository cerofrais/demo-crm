/**
 * Backfill the "wa:<number>" guest tags for every conversation that already
 * happened — see lib/whatsapp-number-tag.ts for what they mean and why they
 * key on the phone number rather than Evolution's instance name.
 *
 * The hard part is that Message.mailboxId holds an instanceName, and a
 * QR-paired line gets a brand new one every time it is re-paired: this
 * deployment has 12 distinct mailboxIds for 3 real numbers (the …60 line
 * alone accounts for four of them), and 11 of the 12 no longer have a
 * WhatsAppNumber row at all, having been deleted and re-created. So each
 * mailbox is resolved to a number in two steps:
 *
 *   1. the WhatsAppNumber row, when the instance still exists;
 *   2. otherwise the messages themselves — an outbound message's fromEmail,
 *      or an inbound one's toEmail, IS our own number on that line.
 *
 * Step 2 takes the most common value rather than the first, so one row with a
 * stray number can't rename a whole mailbox, and it reports the spread when a
 * mailbox isn't unanimous. Instance NAMES are never parsed for digits, even
 * though most of them contain the number: "tre-sales-phone-mt40qvow" is
 * +918977766852, so parsing would have silently invented a fourth number.
 *
 * Mailboxes that resolve to nothing (dead test instances with no number on
 * any row) are reported and skipped — their guests simply keep whatever tags
 * they already have. Failed sends never count; see the module above.
 *
 *   npx tsx scripts/backfill-whatsapp-number-tags.ts          # report only
 *   npx tsx scripts/backfill-whatsapp-number-tags.ts --apply  # do it
 */
import { PrismaClient } from "@prisma/client";
import { whatsAppNumberTag } from "../src/lib/lead-tags";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

interface MailboxRow {
  mailboxId: string;
  ours: string | null;
  n: bigint;
}

async function resolveMailboxes(): Promise<Map<string, string>> {
  const numbers = await prisma.whatsAppNumber.findMany({
    select: { instanceName: true, phoneNumber: true },
  });
  const byInstance = new Map<string, string>();
  for (const n of numbers) {
    if (n.phoneNumber) byInstance.set(n.instanceName, n.phoneNumber);
  }

  // Our own number per mailbox, as the messages themselves record it.
  const rows = await prisma.$queryRaw<MailboxRow[]>`
    SELECT "mailboxId",
           CASE WHEN direction = 'outbound' THEN "fromEmail" ELSE "toEmail" END AS ours,
           count(*) AS n
    FROM "Message"
    WHERE channel = 'whatsapp' AND "mailboxId" IS NOT NULL
    GROUP BY 1, 2
  `;

  const tally = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.ours) continue;
    const m = tally.get(r.mailboxId) ?? new Map<string, number>();
    m.set(r.ours, (m.get(r.ours) ?? 0) + Number(r.n));
    tally.set(r.mailboxId, m);
  }

  const resolved = new Map<string, string>();
  const mailboxes = new Set([...tally.keys(), ...byInstance.keys()]);
  for (const mailbox of mailboxes) {
    const fromRow = byInstance.get(mailbox);
    const counts = tally.get(mailbox);
    const ranked = counts ? [...counts.entries()].sort((a, b) => b[1] - a[1]) : [];
    const fromMessages = ranked[0]?.[0];
    const pick = fromRow ?? fromMessages;
    if (!pick) continue;
    resolved.set(mailbox, pick);

    if (ranked.length > 1) {
      console.log(
        `NOTE  ${mailbox} — messages name more than one of our numbers ` +
          `(${ranked.map(([p, c]) => `${p}×${c}`).join(", ")}); using ${pick}`,
      );
    }
    if (fromRow && fromMessages && fromRow !== fromMessages) {
      console.log(
        `NOTE  ${mailbox} — number row says ${fromRow}, messages say ${fromMessages}; using the number row`,
      );
    }
  }
  return resolved;
}

async function main() {
  const resolved = await resolveMailboxes();

  const unresolved = await prisma.$queryRaw<{ mailboxId: string; n: bigint }[]>`
    SELECT "mailboxId", count(*) AS n
    FROM "Message"
    WHERE channel = 'whatsapp' AND "mailboxId" IS NOT NULL
    GROUP BY 1
  `;
  for (const u of unresolved) {
    if (!resolved.has(u.mailboxId)) {
      console.log(`SKIP  ${u.mailboxId} — ${u.n} message(s), but no number on any of them; guests left untagged`);
    }
  }

  // Group the mailboxes by the number they resolve to, so the four instances
  // of the same line produce ONE tag rather than four.
  const byNumber = new Map<string, string[]>();
  for (const [mailbox, number] of resolved) {
    byNumber.set(number, [...(byNumber.get(number) ?? []), mailbox]);
  }

  console.log(`\nResolved ${resolved.size} mailbox(es) to ${byNumber.size} number(s):`);
  for (const [number, mailboxes] of byNumber) {
    console.log(`  ${whatsAppNumberTag(number)}  ${number}  (${mailboxes.length} instance(s))`);
  }
  console.log();

  let tagged = 0;
  for (const [number, mailboxes] of byNumber) {
    const tag = whatsAppNumberTag(number);
    if (!tag) continue;

    // Guests with at least one message on this line that wasn't refused.
    const rows = await prisma.message.findMany({
      where: {
        channel: "whatsapp",
        mailboxId: { in: mailboxes },
        status: { not: "failed" },
        guestId: { not: null },
        deletedAt: null,
      },
      select: { guestId: true },
      distinct: ["guestId"],
    });
    const guestIds = rows.map((r) => r.guestId!).filter(Boolean);

    if (!APPLY) {
      const already = await prisma.guest.count({
        where: { id: { in: guestIds }, deletedAt: null, tags: { has: tag } },
      });
      const live = await prisma.guest.count({ where: { id: { in: guestIds }, deletedAt: null } });
      console.log(`PLAN  ${tag}  ${live} guest(s), ${live - already} to add`);
      tagged += live - already;
      continue;
    }

    // Set-based and idempotent, same shape as the live path — a re-run adds
    // nothing and doesn't churn updatedAt.
    const n = await prisma.$executeRaw`
      UPDATE "Guest"
      SET tags = array_append(tags, ${tag}), "updatedAt" = now()
      WHERE id = ANY(${guestIds}::text[])
        AND "deletedAt" IS NULL
        AND NOT (tags @> ARRAY[${tag}]::text[])
    `;
    await prisma.tag.upsert({
      where: { value: tag },
      update: {},
      create: { value: tag, category: "whatsapp", createdBy: "system" },
    });
    console.log(`FIX   ${tag}  tagged ${n} guest(s)`);
    tagged += n;
  }

  console.log(`\n${APPLY ? "Tagged" : "Would tag"} ${tagged} guest(s).`);
  if (!APPLY) console.log("Re-run with --apply to make the change.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
