/**
 * Correct inbound WhatsApp messages that were stamped with the time our
 * webhook *received* them instead of the time the customer actually sent
 * them.
 *
 * Cloud API inbound used to reach us through Evolution API, which crashes on
 * these payloads (329 times in 40h on 2026-08-27, the ChannelStartupService
 * TypeError). Deliveries caught in that surfaced hours later, and the old
 * relay path had no usable send time to store, so `createdAt` fell back to
 * now() — i.e. arrival. Six messages between 25 and 27 Aug landed 14 to 35
 * hours late, each appearing in the CRM as a fresh lead with an apparently
 * fresh 24-hour window. Reps replied inside what looked like the window and
 * Meta refused with 131047, correctly: the real window had closed.
 *
 * The forward fix is already in: Cloud API talks to Meta directly and reads
 * Meta's own `timestamp` (arrival and send time now agree to ~3 seconds).
 * This only repairs what came before it.
 *
 * Ground truth is Evolution's own Message table, which recorded the raw
 * payload's messageTimestamp for every message it handled, back to 3 Aug.
 * Export it first — the two live in separate databases on the same server,
 * and this script deliberately takes no second database dependency:
 *
 *   docker exec -i tre-postgres psql -U "$WA_DB_USER" -d "$WA_DB_NAME" -tA -F, -c \
 *     "SELECT m.key->>'id', m.\"messageTimestamp\", coalesce((m.key->>'fromMe')::boolean,false)
 *      FROM \"Message\" m JOIN \"Instance\" i ON i.id=m.\"instanceId\"
 *      WHERE m.key->>'id' IS NOT NULL;" > /tmp/evo.csv
 *
 *   npx tsx scripts/fix-delayed-inbound-timestamps.ts /tmp/evo.csv          # report
 *   npx tsx scripts/fix-delayed-inbound-timestamps.ts /tmp/evo.csv --apply  # do it
 *
 * Only ever moves a timestamp BACKWARDS, to the send time. A row whose stored
 * time is already earlier than WhatsApp's would mean the truth file is wrong
 * for that row, so it is reported and skipped rather than "corrected".
 *
 * Enquiry.lastActivityAt is deliberately left alone. It drives board ordering
 * and the needs-attention queue; a lead that reached us late still needs
 * answering now, and backdating it would bury exactly the conversations
 * someone has to look at.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const CSV = process.argv.find((a) => a.endsWith(".csv"));

/** Anything under this is clock jitter between our box and WhatsApp, not drift. */
const TOLERANCE_MS = 2 * 60 * 1000;
/** How far either side of a message's stored time its Activity row may sit.
 *  Both are written in the same request, milliseconds apart. */
const ACTIVITY_WINDOW_MS = 5000;

function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

async function main() {
  if (!CSV) {
    console.error("Pass the ground-truth CSV — see the header of this file for how to export it.");
    process.exit(1);
  }

  const truth = new Map<string, Date>();
  for (const line of readFileSync(CSV, "utf8").split("\n")) {
    const [wamid, ts] = line.trim().split(",");
    if (!wamid || !ts) continue;
    const secs = Number(ts);
    if (!Number.isFinite(secs) || secs <= 0) continue;
    truth.set(wamid, new Date(secs * 1000));
  }
  console.log(`Ground truth: ${truth.size} messages.\n`);

  const rows = await prisma.message.findMany({
    where: { channel: "whatsapp", direction: "inbound", externalId: { in: [...truth.keys()] } },
    select: { id: true, externalId: true, createdAt: true, guestId: true, fromEmail: true },
    orderBy: { createdAt: "asc" },
  });

  let fixed = 0;
  let activitiesFixed = 0;
  let skipped = 0;

  for (const row of rows) {
    const actual = truth.get(row.externalId!)!;
    const driftMs = row.createdAt.getTime() - actual.getTime();
    if (Math.abs(driftMs) <= TOLERANCE_MS) continue;

    if (driftMs < 0) {
      console.log(
        `SKIP  ${row.fromEmail} — stored time is ${hours(-driftMs)} EARLIER than WhatsApp's; truth file looks wrong for this row`,
      );
      skipped++;
      continue;
    }

    console.log(
      `${APPLY ? "FIX " : "PLAN"}  ${row.fromEmail}  ${row.createdAt.toISOString()} -> ${actual.toISOString()}  (recorded ${hours(driftMs)} late)`,
    );
    if (!APPLY) {
      fixed++;
      continue;
    }

    // The Activity row written alongside this message, matched on the stored
    // time it is about to stop agreeing with. Resolved BEFORE the message
    // moves, and only when exactly one candidate matches — two inbound
    // messages from the same guest in the same five seconds is ambiguous, and
    // guessing would misdate an unrelated timeline entry.
    const candidates = await prisma.activity.findMany({
      where: {
        guestId: row.guestId,
        actionType: "message_received",
        createdAt: {
          gte: new Date(row.createdAt.getTime() - ACTIVITY_WINDOW_MS),
          lte: new Date(row.createdAt.getTime() + ACTIVITY_WINDOW_MS),
        },
      },
      select: { id: true },
    });

    await prisma.$transaction(async (tx) => {
      await tx.message.update({ where: { id: row.id }, data: { createdAt: actual } });
      if (candidates.length === 1) {
        await tx.activity.update({ where: { id: candidates[0].id }, data: { createdAt: actual } });
        activitiesFixed++;
      }
    });
    if (candidates.length !== 1) {
      console.log(
        `      (${candidates.length} matching Activity rows — left alone, timeline entry keeps the arrival time)`,
      );
    }
    fixed++;
  }

  console.log(
    `\n${APPLY ? "Corrected" : "Would correct"} ${fixed} message(s)` +
      (APPLY ? `, ${activitiesFixed} activity row(s)` : "") +
      (skipped ? `; skipped ${skipped}` : "") +
      `. Checked ${rows.length} inbound messages against ground truth.`,
  );
  if (!APPLY) console.log("Re-run with --apply to make the change.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
