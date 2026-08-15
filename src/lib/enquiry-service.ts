import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { findReturningGuest, toEnquiryDTO, withCurrentAssigneeName } from "./enquiries";
import { reviveGuestIfDeleted } from "./guest-revive";
import { syncEnquiryTags } from "./tags-service";
import { assignNextRep } from "./lead-routing";
import { pickAssigneeForCategory, pickAssigneeForCampaign } from "./lead-assignment";
import { slugifyTag } from "./lead-tags";
import type { CreateEnquiryInput } from "./validation";
import type { EnquiryDTO } from "./types";

// A burst of near-simultaneous submissions for the same guest — a double
// click on a web form, or two lead-gen integrations firing for one real
// conversion — used to open a separate card per submission. Anything this
// close together for a guest whose card hasn't been touched yet is treated
// as the same lead event and folded into the first card instead.
const DUPLICATE_MERGE_WINDOW_MS = 30 * 60 * 1000;

/** A campaign rule (if the lead's campaignLabel matches one) wins over the
 *  channel default — it's more specific targeting. WhatsApp/email/Google
 *  Sheets can also be restricted to specific staff via the admin
 *  lead-assignment page; every other source/uncovered campaign keeps the
 *  default pool. */
async function resolveAutoAssignee(
  source: string,
  campaignLabel?: string | null,
): Promise<{ sub: string; name: string } | null> {
  const byCampaign = await pickAssigneeForCampaign(campaignLabel);
  if (byCampaign) return byCampaign;
  return source === "whatsapp" || source === "email" || source === "google_sheets"
    ? pickAssigneeForCategory(source)
    : assignNextRep();
}

export interface CreateResult {
  enquiry: EnquiryDTO;
  returning: {
    isReturning: boolean;
    priorEnquiries: number;
    lastStage?: string;
  };
  /** True when this call didn't open a new card — it folded a near-simultaneous
   *  duplicate submission into an already-existing, still-fresh one instead. */
  merged?: boolean;
  /** True when this call didn't open a new card — `externalRef` already
   *  matched a previously-created enquiry, so the existing one was returned
   *  unchanged. Distinct from `merged`, which folds a genuinely different
   *  near-simultaneous submission into an existing card. */
  duplicate?: boolean;
}

interface Actor {
  sub: string;
  name: string;
  role: string;
}

interface MergeInput {
  source: string;
  campaignLabel?: string | null;
  note?: string | null;
  preferredCheckIn?: Date | null;
  enquiryTags?: string[];
}

/**
 * Folds a duplicate submission into `target` rather than opening a second
 * card for it — appends the extra source/campaign to the card's notes and a
 * lightweight tag so the second channel isn't silently lost, and backfills
 * campaignLabel only if the card didn't already have one.
 *
 * It also carries over what the guest actually said the second time: their
 * check-in date, any package tag, and the second form's own intake notes.
 * Those used to be dropped on the floor — a guest resubmitting with a new
 * date left the card showing the original.
 */
async function mergeDuplicateSubmission(
  target: {
    id: string;
    guestId: string;
    tags: string[];
    intakeNotes: string | null;
    campaignLabel: string | null;
    stage: string;
    preferredCheckIn: Date | null;
  },
  input: MergeInput,
  actor?: Actor | null,
): Promise<CreateResult> {
  const dupTag = slugifyTag(`also ${input.source}`);
  const detail = input.campaignLabel ? ` (campaign: ${input.campaignLabel})` : "";

  // The newer submission wins on the date. This only runs for an untouched
  // new_lead card inside the 30-minute window, so there is no rep edit to
  // clobber — and the guest correcting their own date minutes later is
  // exactly the case worth honouring. The old value goes into the note so
  // the change is visible rather than silent.
  const newDate = input.preferredCheckIn ?? null;
  const dateChanged =
    newDate != null && target.preferredCheckIn?.getTime() !== newDate.getTime();
  const dateNote = dateChanged
    ? target.preferredCheckIn
      ? ` — check-in updated to ${newDate.toISOString().slice(0, 10)} (was ${target.preferredCheckIn.toISOString().slice(0, 10)})`
      : ` — check-in ${newDate.toISOString().slice(0, 10)}`
    : "";

  const noteLine = `[duplicate merged] ${new Date().toISOString()} — also submitted via ${input.source}${detail}${dateNote}`;
  // The second form's own answers (wellness focus, message, …). Skipped when
  // identical to what's already on the card, which is the common case for a
  // true double-submit and would otherwise duplicate the whole block.
  const extraNote =
    input.note && input.note.trim() && !target.intakeNotes?.includes(input.note.trim())
      ? `\n${input.note.trim()}`
      : "";

  const updated = await prisma.enquiry.update({
    where: { id: target.id },
    data: {
      // Union, so a second submission naming a different package leaves BOTH
      // on the card — the guest is weighing two, which the rep should see.
      tags: Array.from(new Set([...target.tags, dupTag, ...(input.enquiryTags ?? [])])),
      intakeNotes: (target.intakeNotes ? `${target.intakeNotes}\n${noteLine}` : noteLine) + extraNote,
      campaignLabel: target.campaignLabel ?? input.campaignLabel ?? undefined,
      ...(dateChanged ? { preferredCheckIn: newDate } : {}),
      lastActivityAt: new Date(),
    },
    include: { guest: true },
  });

  await prisma.activity.create({
    data: {
      enquiryId: target.id,
      guestId: target.guestId,
      actorSub: actor?.sub ?? "system",
      actorRole: actor?.role ?? "system",
      actorName: actor?.name ?? "Inbound",
      actionType: "duplicate_merged",
      metadata: {
        source: input.source,
        campaignLabel: input.campaignLabel ?? null,
        // What the merge actually carried across, so the audit trail explains
        // a changed date rather than it just appearing.
        preferredCheckIn: dateChanged ? newDate!.toISOString() : null,
        previousCheckIn: dateChanged ? (target.preferredCheckIn?.toISOString() ?? null) : null,
        tagsAdded: input.enquiryTags?.filter((t) => !target.tags.includes(t)) ?? [],
      },
    },
  });

  await syncEnquiryTags(target.id);

  return {
    enquiry: await withCurrentAssigneeName(toEnquiryDTO(updated)),
    returning: { isReturning: true, priorEnquiries: 1, lastStage: target.stage },
    merged: true,
  };
}

/**
 * Create an enquiry from any source (manual UI, website webhook, WhatsApp).
 * Implements returning-guest recognition (spec §6.1): if a guest already exists
 * by phone/email we reuse them and flag the enquiry as returning, instead of
 * asking for the same info again (goal #2).
 *
 * New enquiries land in `new_lead`. Assignment depends on how the lead came
 * in: an explicit `assignedTo` (manual UI creation — the creator claims it
 * themselves; call routing — whoever answered) always wins; otherwise it's
 * automatically round-robin-assigned to a Sales rep (falling back to
 * Reception if no Sales rep exists — see lead-routing.ts), or unassigned if
 * no staff exist in either role. An Admin/Manager can always reassign it
 * afterward, same as any other lead.
 */
export async function createEnquiry(
  // phone is optional (email/social leads); source widened to allow "email".
  input: Omit<CreateEnquiryInput, "phone" | "source"> & {
    phone?: string | null;
    source: string;
    // Skips round-robin (assignNextRep) in favor of a known-better owner —
    // e.g. an inbound call already has the rep who answered it, a much
    // more informed pick than round robin would make.
    assignedTo?: { sub: string; name: string } | null;
    // Permanent dedup key for webhook-sourced leads (see Enquiry.externalRef).
    // Only ever set by the enquiry-form webhook today.
    externalRef?: string | null;
  },
  actor?: Actor | null,
): Promise<CreateResult> {
  // Exact-match short-circuit, checked before anything else: an externalRef
  // hit means this literal source event was already processed (possibly
  // days ago, e.g. a replay from the n8n error-recovery workflow) — return
  // the existing card untouched rather than the guest-level returning/merge
  // logic below, which only guards near-simultaneous submissions.
  if (input.externalRef) {
    const dup = await prisma.enquiry.findUnique({
      where: { externalRef: input.externalRef },
      include: { guest: true },
    });
    if (dup) {
      return {
        enquiry: await withCurrentAssigneeName(toEnquiryDTO(dup)),
        returning: { isReturning: true, priorEnquiries: 1, lastStage: dup.stage },
        duplicate: true,
      };
    }
  }

  // includeDeleted: a soft-deleted guest still owns their phone/email on the
  // unique index, so ignoring them here means falling through to a create that
  // dies on a P2002. Matching them and reviving keeps the guest's whole
  // history — tags, health record, past conversations — on one record.
  const existing = await findReturningGuest(input.phone, input.email, {
    includeDeleted: true,
  });
  if (existing?.deletedAt) {
    await reviveGuestIfDeleted(existing.id, `new ${input.source} enquiry`);
  }

  const referral = input.referralCode
    ? await prisma.referralCode.findUnique({ where: { code: input.referralCode.toUpperCase() } })
    : null;

  let guestId: string;
  let isReturning = false;
  let priorEnquiries = 0;
  let lastStage: string | undefined;

  if (existing) {
    isReturning = true;
    priorEnquiries = existing._count.enquiries;
    lastStage = existing.enquiries[0]?.stage;
    guestId = existing.id;
    // Top up only missing contact details; never overwrite known data.
    await prisma.guest.update({
      where: { id: existing.id },
      data: {
        isReturning: true,
        email: existing.email ?? input.email,
        city: existing.city ?? input.city,
        dateOfBirth: existing.dateOfBirth ?? input.dateOfBirth,
        tags: input.tags?.length
          ? Array.from(new Set([...existing.tags, ...input.tags]))
          : existing.tags,
      },
    });

    // Only for unattended sources (webhook, inbound WhatsApp/email, call
    // auto-creation — anywhere `actor` is null). The manual "create lead" UI
    // already warns a staff member before they create a duplicate on
    // purpose — this guard is for submissions no human ever looked at.
    if (!actor) {
      const recentOpen = await prisma.enquiry.findFirst({
        where: {
          guestId: existing.id,
          deletedAt: null,
          stage: "new_lead",
          createdAt: { gte: new Date(Date.now() - DUPLICATE_MERGE_WINDOW_MS) },
        },
        orderBy: { createdAt: "desc" },
      });
      if (recentOpen) {
        return mergeDuplicateSubmission(recentOpen, input, actor);
      }
    }
  } else {
    const guest = await prisma.guest.create({
      data: {
        fullName: input.fullName,
        phone: input.phone,
        email: input.email,
        city: input.city,
        gender: input.gender,
        dateOfBirth: input.dateOfBirth ?? undefined,
        tags: input.tags ?? [],
        referralCodeUsed: referral?.code,
      },
    });
    guestId = guest.id;
  }

  const rep = input.assignedTo ?? (await resolveAutoAssignee(input.source, input.campaignLabel).catch(() => null));

  let enquiry;
  try {
    enquiry = await prisma.enquiry.create({
      data: {
        guestId,
        source: input.source as never,
        stage: "new_lead",
        isReturningFlag: isReturning,
        campaignLabel: input.campaignLabel,
        // Plain field, not a Note/remark — simpler for automations (n8n, the
        // public enquiry-form webhook) to fill in without a second write, and
        // doesn't clutter the remarks timeline with machine-generated text.
        intakeNotes: input.note || undefined,
        preferredCheckIn: input.preferredCheckIn ?? null,
        // Seeded before syncEnquiryTags() runs below — mergeLeadTags keeps
        // anything that isn't a system tag, so these survive and the computed
        // age/source/revisit tags are layered on top.
        tags: input.enquiryTags ?? [],
        referralCodeId: referral?.id,
        lastActivityAt: new Date(),
        assignedToSub: rep?.sub ?? null,
        assignedToName: rep?.name ?? null,
        externalRef: input.externalRef || null,
      },
      include: { guest: true },
    });
  } catch (err) {
    // Two near-simultaneous calls with the same externalRef can both pass the
    // findUnique check above before either commits — the unique constraint
    // catches that race; treat it the same as the earlier short-circuit
    // rather than surfacing a 500 for what is really just a duplicate.
    if (
      input.externalRef &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const dup = await prisma.enquiry.findUniqueOrThrow({
        where: { externalRef: input.externalRef },
        include: { guest: true },
      });
      return {
        enquiry: await withCurrentAssigneeName(toEnquiryDTO(dup)),
        returning: { isReturning: true, priorEnquiries: 1, lastStage: dup.stage },
        duplicate: true,
      };
    }
    throw err;
  }

  await prisma.activity.create({
    data: {
      enquiryId: enquiry.id,
      guestId,
      actorSub: actor?.sub ?? "system",
      actorRole: actor?.role ?? "system",
      actorName: actor?.name ?? "Inbound",
      actionType: "created",
      metadata: { source: input.source, returning: isReturning },
    },
  });

  // Skipped when the rep IS the actor (manual creation assigns the creator
  // to their own lead) — the "created" activity above already says who did
  // that; a second "assigned to themselves" line would just be noise.
  if (rep && rep.sub !== actor?.sub) {
    await prisma.activity.create({
      data: {
        enquiryId: enquiry.id,
        guestId,
        actorSub: "system",
        actorRole: "system",
        actorName: input.assignedTo ? "Call routing" : "Auto-assign",
        actionType: "assign",
        metadata: { to: rep.name },
      },
    });
  }

  // Register any ingested tag (e.g. a package preference off the enquiry
  // form) in the shared vocabulary, so it shows up in the tag picker as ONE
  // entry that staff then reuse — rather than a value that exists on cards
  // but not in the list, which is how you end up with two chips meaning the
  // same thing. Upsert, so an existing staff-created tag is left untouched.
  for (const tag of input.enquiryTags ?? []) {
    await prisma.tag.upsert({
      where: { value: tag },
      update: {},
      create: { value: tag, category: "custom", createdBy: "system" },
    });
  }

  // Persist the auto-computed system tags (age/revisit/source).
  await syncEnquiryTags(enquiry.id);

  return {
    enquiry: await withCurrentAssigneeName(toEnquiryDTO(enquiry)),
    returning: { isReturning, priorEnquiries, lastStage },
  };
}
