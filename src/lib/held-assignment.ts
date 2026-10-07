/**
 * Leads that arrived when nobody eligible was on shift, and the worker that
 * hands them over as soon as somebody is.
 *
 * Without this a 3am lead on a day nobody works nights would sit unassigned
 * until a human noticed. The HeldAssignment row is the queue: it exists while
 * the lead waits and is deleted the moment it finds an owner, so there is no
 * separate "was this held?" state to keep in sync.
 *
 * The routing inputs are copied onto the row rather than re-derived, because
 * two of them cannot be recovered later: the WhatsApp number that received
 * the message is not stored on Enquiry at all, and the lead's tags will have
 * grown by then — auto-tagging adds to them from every inbound message — so
 * replaying the decision an hour later would skip the number rule and match
 * tag rules the lead did not arrive with.
 */
import { prisma } from "./prisma";
import { logger } from "./logger";
import { resolveAutoAssignee } from "./enquiry-service";

/**
 * Record that a lead could not be auto-assigned yet. Safe to call for a lead
 * that is already held — the same lead arriving twice is one queue entry.
 */
export async function holdAssignment(input: {
  enquiryId: string;
  source: string;
  campaignLabel?: string | null;
  ourWhatsAppNumber?: string | null;
  tags?: string[] | null;
}): Promise<void> {
  try {
    await prisma.heldAssignment.upsert({
      where: { enquiryId: input.enquiryId },
      create: {
        enquiryId: input.enquiryId,
        source: input.source,
        campaignLabel: input.campaignLabel ?? null,
        ourWhatsAppNumber: input.ourWhatsAppNumber ?? null,
        tags: input.tags ?? [],
      },
      update: {},
    });
    logger.info({ enquiryId: input.enquiryId, source: input.source }, "lead held — nobody on shift");
  } catch (err) {
    // Never let queueing failure break lead creation; the lead still exists,
    // it is just unassigned.
    logger.error({ err, enquiryId: input.enquiryId }, "could not hold lead for later assignment");
  }
}

/** How many failed attempts before a held lead is logged loudly rather than quietly. */
const NOISY_AFTER_ATTEMPTS = 20;

/**
 * Try to place every held lead. Called on a timer from instrumentation-node,
 * alongside the other in-process workers.
 *
 * Three outcomes per row:
 *   • the lead already has an owner (a human claimed it) — drop the row, do
 *     nothing else;
 *   • somebody is now on shift — assign, drop the row, note it on the lead;
 *   • still nobody — bump attempts and leave it queued.
 *
 * Deliberately does NOT give up after N attempts. A lead nobody is rostered
 * to cover should keep waiting and stay visibly unassigned, rather than being
 * dumped on someone who is off — the same reasoning that made it wait in the
 * first place. It just gets noisier in the logs.
 */
export async function tickHeldAssignments(): Promise<void> {
  const held = await prisma.heldAssignment.findMany({ orderBy: { heldAt: "asc" }, take: 100 });
  if (!held.length) return;

  for (const row of held) {
    try {
      const enquiry = await prisma.enquiry.findUnique({
        where: { id: row.enquiryId },
        select: { id: true, assignedToSub: true, deletedAt: true, guestId: true },
      });

      // Gone or already owned — either way there is nothing left to place.
      if (!enquiry || enquiry.deletedAt || enquiry.assignedToSub) {
        await prisma.heldAssignment.delete({ where: { enquiryId: row.enquiryId } });
        continue;
      }

      const rep = await resolveAutoAssignee(row.source, row.campaignLabel, row.ourWhatsAppNumber, row.tags);
      if (!rep) {
        const attempts = row.attempts + 1;
        await prisma.heldAssignment.update({
          where: { enquiryId: row.enquiryId },
          data: { attempts },
        });
        if (attempts === NOISY_AFTER_ATTEMPTS || attempts % 100 === 0) {
          logger.warn(
            { enquiryId: row.enquiryId, source: row.source, attempts, heldAt: row.heldAt },
            "lead still unassigned — nobody on shift for this channel",
          );
        }
        continue;
      }

      await prisma.$transaction([
        prisma.enquiry.update({
          where: { id: row.enquiryId },
          data: { assignedToSub: rep.sub, assignedToName: rep.name },
        }),
        prisma.activity.create({
          data: {
            enquiryId: row.enquiryId,
            guestId: enquiry.guestId,
            actorSub: "system",
            actorRole: "system",
            actorName: "Shift handover",
            actionType: "assign",
            metadata: {
              from: "Unassigned",
              to: rep.name,
              reason: "Held until someone was on shift",
              heldAt: row.heldAt.toISOString(),
            },
          },
        }),
        prisma.heldAssignment.delete({ where: { enquiryId: row.enquiryId } }),
      ]);

      logger.info({ enquiryId: row.enquiryId, to: rep.name }, "held lead assigned on shift start");
    } catch (err) {
      logger.error({ err, enquiryId: row.enquiryId }, "held-assignment tick failed for lead");
    }
  }
}
