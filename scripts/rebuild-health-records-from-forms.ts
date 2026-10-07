/**
 * Rebuild health records from the screening-form emails that created them.
 *
 * WHY THIS EXISTS
 * HealthProfile used to be one row per guest. A family shares a phone number
 * and Guest.phone is unique, so several people's forms resolved to the same
 * guest and were merged into a single record — three Siddis' medical history
 * blended into one. The model is now one record per submission; this replays
 * the stored form emails so history matches.
 *
 * WHAT IT DOES, per form email:
 *   • parses it back into contact + health (same parser the live path uses);
 *   • creates one record, stamped with the form's own subject and the email's
 *     Message-ID, which is the idempotency key — re-running changes nothing;
 *   • then retires the guest's legacy merged record, but ONLY when nobody has
 *     hand-edited it. A record a doctor has touched is left alone and
 *     reported, because this script cannot know what they changed.
 * Finally it recomputes `hasDuplicate` across every subject.
 *
 *   npx tsx scripts/rebuild-health-records-from-forms.ts            # report only
 *   npx tsx scripts/rebuild-health-records-from-forms.ts --apply    # do it
 *   npx tsx scripts/rebuild-health-records-from-forms.ts --phone=+91...
 *   npx tsx scripts/rebuild-health-records-from-forms.ts --since-days=20
 */
import { PrismaClient } from "@prisma/client";
import { encryptJson } from "../src/lib/crypto";
import { emptyHealthRecord } from "../src/lib/health";
import { parseMedicalScreeningForm } from "../src/lib/medical-form-parser";
import { subjectKey } from "../src/lib/health-ingest";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const ONLY_PHONE = process.argv.find((a) => a.startsWith("--phone="))?.split("=")[1];
const SINCE_DAYS = Number(process.argv.find((a) => a.startsWith("--since-days="))?.split("=")[1] ?? 0);

const SUBJECT = "Pre-Booking Guest Medical Screening Form";

interface ParsedForm {
  messageDbId: string;
  /** Idempotency key: the email's own Message-ID, falling back to our row id
   *  for the handful of emails that arrived without one. */
  sourceMessageId: string;
  receivedAt: Date;
  subjectName: string;
  phone: string;
  email: string | null;
  health: Record<string, unknown>;
}

async function loadForms(): Promise<ParsedForm[]> {
  const messages = await prisma.message.findMany({
    where: {
      direction: "inbound",
      subject: { contains: SUBJECT },
      ...(SINCE_DAYS > 0
        ? { createdAt: { gt: new Date(Date.now() - SINCE_DAYS * 86_400_000) } }
        : {}),
    },
    select: { id: true, messageId: true, body: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const out: ParsedForm[] = [];
  for (const m of messages) {
    const parsed = parseMedicalScreeningForm(m.body);
    // Unparseable, or missing the phone the whole match depends on. Reported
    // rather than skipped silently — a form we can't place is a form whose
    // health data never reached anyone.
    if (!parsed || !parsed.contact.phone) {
      console.warn(`  ! could not parse form ${m.id} (${m.createdAt.toISOString().slice(0, 10)})`);
      continue;
    }
    if (ONLY_PHONE && parsed.contact.phone !== ONLY_PHONE) continue;
    out.push({
      messageDbId: m.id,
      sourceMessageId: m.messageId ?? `crm-msg:${m.id}`,
      receivedAt: m.createdAt,
      subjectName: parsed.contact.fullName,
      phone: parsed.contact.phone,
      email: parsed.contact.email,
      health: parsed.health as Record<string, unknown>,
    });
  }
  return out;
}

/** Has a human ever written to this guest's health record? The system actor
 *  the poller uses is the only non-human one. */
async function humanEditCount(guestId: string): Promise<number> {
  return prisma.activity.count({
    where: { guestId, actionType: "health_update", actorSub: { not: "inbound-mail" } },
  });
}

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Find — or create — the guest a form's records hang off.
 *
 * Three steps, in order of how much they prove:
 *   1. the form's phone. A screening form's phone IS its identity.
 *   2. the form's email, but only when the name matches too. The address on
 *      a form is often a relative's or an assistant's, so email alone would
 *      attach one person's medical history to another — which is how these
 *      forms went missing in the first place (Uma Srikonda's email belongs
 *      to B. Sathyavathi Bejjenki's guest record).
 *   3. otherwise a new guest, WITHOUT the email if another guest holds it.
 *      Guest.email is unique; passing a taken address is what made the
 *      original insert fail and lose the submission entirely.
 *
 * No enquiry is created — these people need a health record, not a lead card.
 */
async function resolveGuestForForms(
  phone: string,
  forms: ParsedForm[],
): Promise<{ id: string; fullName: string; created: boolean } | null> {
  const byPhone = await prisma.guest.findFirst({
    where: { phone },
    select: { id: true, fullName: true },
  });
  if (byPhone) return { ...byPhone, created: false };

  const names = new Set(forms.map((f) => norm(f.subjectName)));
  for (const f of forms) {
    const email = f.email;
    if (!email) continue;
    const byEmail = await prisma.guest.findFirst({
      where: { email },
      select: { id: true, fullName: true },
    });
    if (byEmail && names.has(norm(byEmail.fullName))) {
      console.log(`    (matched existing guest "${byEmail.fullName}" by email — different phone on file)`);
      return { ...byEmail, created: false };
    }
  }

  const primary = forms[0];
  const email = primary.email;
  const emailTaken = email
    ? Boolean(await prisma.guest.findFirst({ where: { email }, select: { id: true } }))
    : false;
  console.log(
    `    ${APPLY ? "NEW " : "PLAN"} guest ${primary.subjectName} (${phone})` +
      (emailTaken ? "  [email belongs to someone else — stored without it]" : ""),
  );
  if (!APPLY) {
    // Nothing to attach records to in a dry run; report and move on.
    return null;
  }
  const created = await prisma.guest.create({
    data: {
      fullName: primary.subjectName,
      phone,
      email: emailTaken ? undefined : email ?? undefined,
    },
    select: { id: true, fullName: true },
  });
  return { ...created, created: true };
}

async function main() {
  const forms = await loadForms();
  if (!forms.length) {
    console.log("No screening-form emails matched.");
    return;
  }

  const byPhone = new Map<string, ParsedForm[]>();
  for (const f of forms) byPhone.set(f.phone, [...(byPhone.get(f.phone) ?? []), f]);

  console.log(
    `${forms.length} form email(s) across ${byPhone.size} phone number(s)` +
      `${APPLY ? "" : "  (dry run — pass --apply to write)"}\n`,
  );

  let created = 0;
  let createdGuests = 0;
  let skipped = 0;
  let retired = 0;
  const kept: string[] = [];
  const orphaned: string[] = [];

  for (const [phone, phoneForms] of byPhone) {
    const guest = await resolveGuestForForms(phone, phoneForms);
    if (!guest) {
      orphaned.push(`${phone} — ${phoneForms.map((f) => f.subjectName).join(", ")}`);
      continue;
    }
    if (guest.created) createdGuests++;

    const people = new Set(phoneForms.map((f) => f.subjectName.toLowerCase()));
    const flag = people.size > 1 ? `  << ${people.size} DIFFERENT PEOPLE` : "";
    console.log(`${guest.fullName} (${phone})${flag}`);

    for (const f of phoneForms) {
      const already = await prisma.healthProfile.findUnique({
        where: { sourceMessageId: f.sourceMessageId },
        select: { id: true },
      });
      if (already) {
        skipped++;
        console.log(`    ok   ${f.subjectName} — already rebuilt`);
        continue;
      }
      console.log(
        `    ${APPLY ? "NEW " : "PLAN"} ${f.subjectName}  (form of ${f.receivedAt.toISOString().slice(0, 10)})`,
      );
      if (APPLY) {
        const blob = encryptJson({ ...emptyHealthRecord(), ...f.health });
        await prisma.healthProfile.create({
          data: {
            guestId: guest.id,
            subjectName: f.subjectName,
            subjectPhone: phone,
            sourceMessageId: f.sourceMessageId,
            encryptedData: blob.ciphertext,
            iv: blob.iv,
            authTag: blob.authTag,
          },
        });
      }
      created++;
    }

    // The legacy row is the merged one. It is only safe to drop once the
    // forms that fed it have been rebuilt AND no human has since edited it.
    const legacy = await prisma.healthProfile.findMany({
      where: { guestId: guest.id, sourceMessageId: null },
      select: { id: true },
    });
    if (legacy.length) {
      const edits = await humanEditCount(guest.id);
      if (edits > 0) {
        kept.push(`${guest.fullName} (${phone}) — ${edits} hand edit(s), legacy record kept`);
        console.log(`    keep legacy record — edited by hand ${edits}x, not safe to replace`);
      } else {
        console.log(`    ${APPLY ? "DROP" : "PLAN"} legacy merged record`);
        if (APPLY) {
          await prisma.healthProfile.deleteMany({ where: { id: { in: legacy.map((l) => l.id) } } });
        }
        retired += legacy.length;
      }
    }
  }

  // Recompute the duplicate flag from scratch rather than incrementally: a
  // partial earlier run could otherwise leave a flag that no longer matches
  // what is actually stored.
  console.log("\nRecomputing duplicate flags…");
  const all = await prisma.healthProfile.findMany({
    where: { subjectName: { not: null }, subjectPhone: { not: null } },
    select: { id: true, subjectName: true, subjectPhone: true },
  });
  const groups = new Map<string, string[]>();
  for (const r of all) {
    const k = subjectKey(r.subjectName, r.subjectPhone);
    groups.set(k, [...(groups.get(k) ?? []), r.id]);
  }
  const dupIds = [...groups.values()].filter((ids) => ids.length > 1).flat();
  console.log(`  ${dupIds.length} record(s) share a name+phone with another`);
  if (APPLY) {
    await prisma.healthProfile.updateMany({
      where: { id: { in: dupIds } },
      data: { hasDuplicate: true },
    });
    await prisma.healthProfile.updateMany({
      where: { id: { notIn: dupIds.length ? dupIds : ["-"] } },
      data: { hasDuplicate: false },
    });
  }

  console.log(
    `\n${APPLY ? "Created" : "Would create"} ${created} record(s); ${skipped} already done; ` +
      `${APPLY ? "retired" : "would retire"} ${retired} legacy record(s); ` +
      `${APPLY ? "created" : "would create"} ${createdGuests} guest(s).`,
  );
  if (kept.length) {
    console.log("\nLegacy records kept because a human had edited them:");
    for (const k of kept) console.log(`  ${k}`);
  }
  if (orphaned.length) {
    console.log("\nForms still unplaced (dry run creates no guests — re-run with --apply):");
    for (const o of orphaned) console.log(`  ${o}`);
  }
  if (!APPLY) console.log("\nDry run. Re-run with --apply.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
