/**
 * =============================================================================
 * Backfill preferred check-in, package tag, and age group on leads that
 * predate those fields.
 *
 *   npx tsx scripts/backfill-form-details.ts            # dry run, changes nothing
 *   npx tsx scripts/backfill-form-details.ts --apply    # write
 *
 * The website enquiry form has always carried "Preferred Check in Date",
 * "Package Preference", and "Age", but until the preferredCheckIn column, the
 * package:<slug> tag, and DOB-driven age-group backfill existed, they only
 * survived as free text in intakeNotes. This re-reads that data for leads
 * created before the change. Age arrives as a self-reported integer, not a
 * real birth date, so it's stored as an approximate dateOfBirth (see
 * ageToDateOfBirth) purely to drive the existing ageGroup() bucketing.
 *
 * Sources, in precedence order:
 *   1. the original inbound form EMAIL still on the lead's thread (most
 *      authoritative — it's what the guest actually submitted)
 *   2. the lead's intakeNotes, which formatWebsiteFormNotes() wrote from that
 *      same email; the fallback for a lead whose message was never stored
 *
 * ── What it will NOT do ──────────────────────────────────────────────────────
 *
 *   • Overwrite a preferredCheckIn that already has a value. A rep setting the
 *     date by hand in the drawer is better information than a months-old form,
 *     and one had already done so within minutes of the feature shipping.
 *   • Overwrite a guest's city, or any other field that is already filled.
 *     Only genuinely empty fields are backfilled.
 *   • Touch soft-deleted leads.
 *   • Guess at a date. parseFormDate declines free text ("flexible"), and the
 *     raw string stays in intakeNotes either way, so nothing is lost.
 * =============================================================================
 */
import { prisma } from "../src/lib/prisma";
import { parseWebsiteFormEmail, parseFormDate } from "../src/lib/website-form-parser";
import { packageTag } from "../src/lib/lead-tags";
import { ageToDateOfBirth } from "../src/lib/utils";

const APPLY = process.argv.includes("--apply");

interface Extracted {
  checkinRaw: string | null;
  packageRaw: string | null;
  city: string | null;
  age: number | null;
  from: "email" | "notes";
}

/**
 * intakeNotes as formatWebsiteFormNotes() writes it:
 *   Age: 46
 *   Preferred check-in: 2026-08-14
 *   Package: Wellness Experience
 * A different shape from the email's own "Preferred Check in Date :" labels,
 * so it needs its own reader rather than parseWebsiteFormEmail.
 */
function fromNotes(notes: string): Extracted | null {
  const checkin = /^Preferred check-in:\s*(.+)$/im.exec(notes);
  const pkg = /^Package:\s*(.+)$/im.exec(notes);
  const age = /^Age:\s*(\d+)$/im.exec(notes);
  if (!checkin && !pkg && !age) return null;
  return {
    checkinRaw: checkin?.[1].trim() ?? null,
    packageRaw: pkg?.[1].trim() ?? null,
    city: null, // the notes never carried city — it went straight to Guest
    age: age ? parseInt(age[1], 10) : null,
    from: "notes",
  };
}

async function main() {
  console.log(APPLY ? "\nAPPLYING changes\n" : "\nDRY RUN — nothing will be written\n");

  const enquiries = await prisma.enquiry.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      tags: true,
      intakeNotes: true,
      preferredCheckIn: true,
      createdAt: true,
      guest: { select: { id: true, fullName: true, city: true, dateOfBirth: true } },
      messages: {
        where: { direction: "inbound", channel: "email" },
        orderBy: { createdAt: "asc" },
        select: { body: true },
      },
    },
  });

  let scanned = 0;
  let checkinSet = 0;
  let tagAdded = 0;
  let citySet = 0;
  let dobSet = 0;
  const dobFilledGuests = new Set<string>();
  const derivedSlugs = new Set<string>();
  let unparseableDate = 0;
  let skippedHasDate = 0;
  const unparseableSamples: string[] = [];

  for (const e of enquiries) {
    // 1. the original email, if it's still on the thread
    let found: Extracted | null = null;
    for (const m of e.messages) {
      const form = parseWebsiteFormEmail(m.body);
      if (form && (form.checkinDate || form.package || form.age != null)) {
        found = {
          checkinRaw: form.checkinDate,
          packageRaw: form.package,
          city: form.city,
          age: form.age,
          from: "email",
        };
        break;
      }
    }
    // 2. fall back to the notes derived from it
    if (!found && e.intakeNotes) found = fromNotes(e.intakeNotes);
    if (!found) continue;
    scanned++;

    const data: { preferredCheckIn?: Date; tags?: string[] } = {};

    if (found.checkinRaw) {
      if (e.preferredCheckIn) {
        skippedHasDate++;
      } else {
        const d = parseFormDate(found.checkinRaw);
        if (d) {
          data.preferredCheckIn = d;
          checkinSet++;
        } else {
          unparseableDate++;
          if (unparseableSamples.length < 8) unparseableSamples.push(found.checkinRaw);
        }
      }
    }

    // The package tag is a plain slug shared with the ones staff add by hand,
    // so "already tagged" is just "already has this exact value".
    const pkgTag = found.packageRaw ? packageTag(found.packageRaw) : null;
    if (pkgTag) derivedSlugs.add(pkgTag);
    if (pkgTag && !e.tags.includes(pkgTag)) {
      data.tags = Array.from(new Set([...e.tags, pkgTag]));
      tagAdded++;
    }

    const cityFill =
      found.city && !e.guest.city?.trim() ? found.city.trim() : null;
    if (cityFill) citySet++;

    // Self-reported age -> approximate DOB, same "only fill what's genuinely
    // empty" rule as city/check-in. Guarded per-guest (not per-enquiry) since
    // several enquiries can share one guest and the read above is a single
    // upfront snapshot — without the guard, two of that guest's leads would
    // each think the DOB was still empty and both try to set it.
    const dobFill =
      found.age != null && !e.guest.dateOfBirth && !dobFilledGuests.has(e.guest.id)
        ? ageToDateOfBirth(found.age)
        : null;
    if (dobFill) {
      dobSet++;
      dobFilledGuests.add(e.guest.id);
    }

    if (!Object.keys(data).length && !cityFill && !dobFill) continue;

    if (APPLY) {
      await prisma.$transaction(async (tx) => {
        if (Object.keys(data).length) {
          await tx.enquiry.update({ where: { id: e.id }, data });
        }
        if (cityFill || dobFill) {
          await tx.guest.update({
            where: { id: e.guest.id },
            data: {
              ...(cityFill ? { city: cityFill } : {}),
              ...(dobFill ? { dateOfBirth: dobFill } : {}),
            },
          });
        }
        await tx.activity.create({
          data: {
            enquiryId: e.id,
            guestId: e.guest.id,
            actorSub: "system",
            actorRole: "system",
            actorName: "Backfill",
            actionType: "form_details_backfilled",
            metadata: {
              source: found!.from,
              preferredCheckIn: data.preferredCheckIn?.toISOString() ?? null,
              packageTag: pkgTag ?? null,
              city: cityFill,
              age: dobFill ? found!.age : null,
            },
          },
        });
      });
    } else {
      console.log(
        `  ${e.guest.fullName.padEnd(26).slice(0, 26)} [${found.from}]` +
          (data.preferredCheckIn ? `  check-in=${data.preferredCheckIn.toISOString().slice(0, 10)}` : "") +
          (data.tags ? `  +${pkgTag}` : "") +
          (cityFill ? `  city=${cityFill}` : "") +
          (dobFill ? `  age=${found.age}` : ""),
      );
    }
  }

  // Every package slug the forms mention goes into the shared vocabulary, so
  // the tag picker offers it. A tag that sits on cards but isn't in the list
  // can't be found by a rep tagging another lead — they type their own
  // variant instead, which is exactly how near-duplicate tags start.
  const known = new Set(
    (
      await prisma.tag.findMany({
        where: { value: { in: [...derivedSlugs] } },
        select: { value: true },
      })
    ).map((t) => t.value),
  );
  const missingVocab = [...derivedSlugs].filter((s) => !known.has(s));
  if (APPLY && missingVocab.length) {
    await prisma.tag.createMany({
      data: missingVocab.map((value) => ({ value, category: "custom", createdBy: "system" })),
      skipDuplicates: true,
    });
  }

  console.log(`
  leads with form data found : ${scanned}
  check-in dates set         : ${checkinSet}
  package tags added         : ${tagAdded}
  guest cities filled        : ${citySet}
  guest ages (-> age group) filled : ${dobSet}
  package slugs added to the tag picker : ${missingVocab.length}${
    missingVocab.length ? ` (${missingVocab.join(", ")})` : ""
  }
  left alone (date already set, rep's value wins) : ${skippedHasDate}
  dates left unparsed (raw text stays in notes)   : ${unparseableDate}${
    unparseableSamples.length ? `\n    e.g. ${unparseableSamples.map((s) => JSON.stringify(s)).join(", ")}` : ""
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
