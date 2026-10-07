/**
 * Move leads that submitted a Pre-Booking medical screening form but never
 * reached Doctor Consultation.
 *
 * Going forward every form lands there on arrival — for a returning guest
 * since 2026-09-03, and for a brand-new one since 2026-09-07. This covers the
 * leads that came in before those changes and would otherwise sit where they
 * are forever.
 *
 * Candidates are leads whose guest has a health record AND a screening-form
 * email on file. The email matters: a health record alone can be typed in by
 * hand from the Health Records screen, and those are not form submissions.
 *
 * Uses moveToDoctorConsultation, the same function the live path calls, so a
 * lead moved here is indistinguishable from one moved on arrival — same
 * guards, same stage_change entry, same doctor-review task, same tag re-sync.
 *
 *   npx tsx scripts/backfill-screening-form-doctor-stage.ts               # report
 *   npx tsx scripts/backfill-screening-form-doctor-stage.ts --apply       # move them
 *   npx tsx scripts/backfill-screening-form-doctor-stage.ts --phone +91…  # just one
 *   npx tsx scripts/backfill-screening-form-doctor-stage.ts --skip-lost   # leave Lost alone
 */
import { PrismaClient } from "@prisma/client";
import { moveToDoctorConsultation } from "../src/lib/inbound-mail";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const SKIP_LOST = process.argv.includes("--skip-lost");
const phoneArg = process.argv.indexOf("--phone");
const ONLY_PHONE = phoneArg > -1 ? process.argv[phoneArg + 1] : null;

async function main() {
  const rows = await prisma.enquiry.findMany({
    where: {
      deletedAt: null,
      // The live guards skip anything at or past the doctor; excluded here
      // too so the report only lists leads that would actually move.
      stage: { notIn: ["doctor_consultation", "payment_received", "booking_confirmed", "converted"] },
      ...(SKIP_LOST ? { stage: { notIn: ["doctor_consultation", "payment_received", "booking_confirmed", "converted", "lost"] } } : {}),
      guest: {
        deletedAt: null,
        ...(ONLY_PHONE ? { phone: ONLY_PHONE } : {}),
        healthProfiles: { some: {} },
        messages: {
          some: {
            channel: "email",
            direction: "inbound",
            // The screening form's own field labels — narrow enough that an
            // ordinary email cannot match both.
            AND: [{ body: { contains: "Date of Birth" } }, { body: { contains: "Blood group" } }],
          },
        },
      },
    },
    select: {
      id: true,
      stage: true,
      deletedAt: true,
      guestId: true,
      guest: { select: { fullName: true, phone: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!rows.length) {
    console.log("Nothing to move — every form submission is already at or past the doctor.");
    return;
  }

  console.log(`${rows.length} lead(s) submitted a screening form but never reached the doctor:\n`);
  for (const r of rows) {
    console.log(`  ${APPLY ? "MOVE" : "PLAN"}  ${(r.guest.fullName ?? "—").padEnd(26)} ${String(r.guest.phone ?? "").padEnd(16)} ${r.stage}`);
  }

  if (!APPLY) {
    console.log(`\nWould move ${rows.length}. Re-run with --apply.`);
    return;
  }

  let moved = 0;
  for (const r of rows) {
    await moveToDoctorConsultation(
      { id: r.id, stage: r.stage, deletedAt: r.deletedAt },
      r.guestId,
      r.guest.fullName,
    );
    moved++;
  }
  console.log(`\nMoved ${moved} lead(s) to Doctor Consultation.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
