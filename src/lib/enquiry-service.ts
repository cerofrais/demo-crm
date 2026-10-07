import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { findReturningGuest, toEnquiryDTO, withCurrentAssigneeName } from "./enquiries";
import { reviveGuestIfDeleted } from "./guest-revive";
import { syncEnquiryTags } from "./tags-service";
import { assignNextRep } from "./lead-routing";
import {
  pickAssigneeForCategory,
  pickAssigneeForCampaign,
  pickAssigneeForTags,
  pickAssigneeForWhatsAppNumber,
  isSourceRouted,
} from "./lead-assignment";
import { slugifyTag, computeSystemTags } from "./lead-tags";
import type { CreateEnquiryInput } from "./validation";
import type { EnquiryDTO } from "./types";
import { holdAssignment } from "./held-assignment";

/**
 * Stages that mean "this lead is finished" — a submission arriving now is new
 * business, not the same conversation, so it earns its own card. Everything
 * else is still being worked, and a second submission belongs on it.
 */
const CLOSED_STAGES = ["lost", "non_leads"] as const;

/** A campaign rule (if the lead's campaignLabel matches one) wins over the
 *  channel default — it's more specific targeting. WhatsApp/email/Google
 *  Sheets can also be restricted to specific staff via the admin
 *  lead-assignment page; every other source/uncovered campaign keeps the
 *  default pool. */
/**
 * Exported so the held-assignment worker can replay exactly this decision
 * when somebody comes on shift — see lib/held-assignment.ts. Anything that
 * diverged from this would route a delayed lead differently from an
 * immediate one.
 */
export async function resolveAutoAssignee(
  source: string,
  campaignLabel?: string | null,
  ourWhatsAppNumber?: string | null,
  tags?: string[] | null,
): Promise<{ sub: string; name: string } | null> {
  // Which of our WhatsApp numbers received the message wins over everything
  // below it: one line may be the doctor's and another the sales line, which
  // is a far more specific routing fact than "arrived on WhatsApp". Only ever
  // set for leads opened by an inbound WhatsApp message.
  const byNumber = await pickAssigneeForWhatsAppNumber(ourWhatsAppNumber);
  if (byNumber) return byNumber;
  const byCampaign = await pickAssigneeForCampaign(campaignLabel);
  if (byCampaign) return byCampaign;
  // Then a tag the lead arrived with. Below campaign because a lead belongs
  // to one campaign but can carry several tags, so this is the looser match
  // of the two; above the per-source default because it is still far more
  // specific than "came in by email".
  const byTag = await pickAssigneeForTags(tags);
  if (byTag) return byTag;
  // Any source that has its own settings row uses it; everything left over
  // (phone, referral, walk_in, other) keeps the default pool. Driven by the
  // enum rather than a hardcoded list, so a channel added there is routable
  // immediately — the previous inline check silently excluded website_form,
  // instagram and facebook, which is how those leads reached every Sales rep
  // regardless of what an admin had configured.
  return isSourceRouted(source) ? pickAssigneeForCategory(source) : assignNextRep();
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

  // On an untouched new_lead the newer submission wins the date: that's a
  // guest correcting themselves minutes later, and there is no rep edit to
  // clobber. Past new_lead a human has been working the card and may have
  // agreed a date on a call, so a web form must NOT silently overwrite it —
  // the submitted date is recorded in the note instead, for the rep to apply
  // if it's right. (Before this merged worked cards, only the first case
  // could occur, which is why the write was unconditional.)
  const newDate = input.preferredCheckIn ?? null;
  const dateDiffers =
    newDate != null && target.preferredCheckIn?.getTime() !== newDate.getTime();
  const mayOverwriteDate = target.stage === "new_lead";
  const dateChanged = dateDiffers && mayOverwriteDate;
  const dateNote = !dateDiffers
    ? ""
    : mayOverwriteDate
      ? target.preferredCheckIn
        ? ` — check-in updated to ${newDate!.toISOString().slice(0, 10)} (was ${target.preferredCheckIn.toISOString().slice(0, 10)})`
        : ` — check-in ${newDate!.toISOString().slice(0, 10)}`
      : ` — they asked for check-in ${newDate!.toISOString().slice(0, 10)}${
          target.preferredCheckIn
            ? ` (card still says ${target.preferredCheckIn.toISOString().slice(0, 10)} — left as is)`
            : ""
        }`;

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
    // Which of OUR WhatsApp numbers received the message that opened this
    // lead, E.164. Set only on the inbound-WhatsApp path; routes the lead via
    // WhatsAppNumberAssignmentRule ahead of the campaign and channel rules.
    ourWhatsAppNumber?: string | null;
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
  // A guest we already know (phone/email matched) — reported to the caller.
  let isReturning = false;
  // A guest who has actually stayed before (see guest-visits.ts) — what the
  // lead's "Returning guest" flag and revisit tag mean. Knowing someone is
  // not the same as them having visited.
  let hasVisited = false;
  let priorEnquiries = 0;
  let lastStage: string | undefined;

  if (existing) {
    isReturning = true;
    hasVisited = existing.isReturning;
    priorEnquiries = existing._count.enquiries;
    lastStage = existing.enquiries[0]?.stage;
    guestId = existing.id;
    // Top up only missing contact details; never overwrite known data.
    await prisma.guest.update({
      where: { id: existing.id },
      data: {
        email: existing.email ?? input.email,
        city: existing.city ?? input.city,
        businessName: existing.businessName ?? input.businessName,
        businessRole: existing.businessRole ?? input.businessRole,
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
      // Any card still being worked, not just an untouched one from the last
      // half hour. The old rule (stage new_lead AND under 30 minutes) only
      // caught double-clicks; a guest who filled in the website form a week
      // after messaging on WhatsApp got a SECOND card while the first was
      // mid-conversation. Both then showed in the pipeline, and — worse — her
      // later WhatsApp replies attached to whichever card was newest, so the
      // thread was split across the two and neither rep saw all of it.
      const openEnquiry = await prisma.enquiry.findFirst({
        where: {
          guestId: existing.id,
          deletedAt: null,
          stage: { notIn: [...CLOSED_STAGES] },
        },
        // Oldest first: the long-running card is the one carrying the history
        // and the rep's context, so the new submission joins it rather than
        // the other way round.
        orderBy: { createdAt: "asc" },
      });
      if (openEnquiry) {
        return mergeDuplicateSubmission(openEnquiry, input, actor);
      }
    }
  } else {
    const guest = await prisma.guest.create({
      data: {
        fullName: input.fullName,
        phone: input.phone,
        email: input.email,
        city: input.city,
        businessName: input.businessName,
        businessRole: input.businessRole,
        gender: input.gender,
        dateOfBirth: input.dateOfBirth ?? undefined,
        tags: input.tags ?? [],
        referralCodeUsed: referral?.code,
      },
    });
    guestId = guest.id;
  }

  // The tags a rule can route on: what the caller supplied PLUS the system
  // tags this lead already qualifies for.
  //
  // The system half is not optional. "foreign" is derived from the guest's
  // phone (see computeSystemTags) and is never passed in by a caller, so a
  // rule keyed on it matched nothing at all — the phone was known here the
  // whole time, it just never reached the resolver. Same for revisit, the
  // age buckets and source:/campaign: tags.
  //
  // Computed from `input` rather than read back from the guest row so it
  // works identically for a brand-new guest and an existing one, and needs
  // no extra query.
  const routingTags = [
    ...(input.enquiryTags ?? []),
    ...computeSystemTags(
      { dateOfBirth: input.dateOfBirth, phone: input.phone },
      {
        source: input.source,
        isReturningFlag: hasVisited,
        campaignLabel: input.campaignLabel,
        preferredCheckIn: input.preferredCheckIn,
      },
    ),
  ];

  const rep =
    input.assignedTo ??
    (await resolveAutoAssignee(
      input.source,
      input.campaignLabel,
      input.ourWhatsAppNumber,
      routingTags,
    ).catch(() => null));
  // Nobody on shift right now. The lead is created unassigned and queued, and
  // the worker hands it over as soon as somebody's shift starts — see
  // lib/held-assignment.ts. Only when we ASKED for an automatic assignee:
  // a lead that arrived with an explicit owner was never waiting on anyone.
  const shouldHold = !input.assignedTo && !rep;

  let enquiry;
  try {
    enquiry = await prisma.enquiry.create({
      data: {
        guestId,
        source: input.source as never,
        stage: "new_lead",
        isReturningFlag: hasVisited,
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

  // Queued only once the lead actually exists, so a creation that threw
  // leaves nothing behind in the queue pointing at no lead.
  if (shouldHold) {
    await holdAssignment({
      enquiryId: enquiry.id,
      source: input.source,
      campaignLabel: input.campaignLabel,
      ourWhatsAppNumber: input.ourWhatsAppNumber,
      // The same list the live decision used, so a held lead placed an hour
      // later routes identically to one placed immediately.
      tags: routingTags,
    });
  }

  await prisma.activity.create({
    data: {
      enquiryId: enquiry.id,
      guestId,
      actorSub: actor?.sub ?? "system",
      actorRole: actor?.role ?? "system",
      actorName: actor?.name ?? "Inbound",
      actionType: "created",
      // `manual` distinguishes a staff member typing the lead in through the
      // "New lead" dialog from every auto-created path (webhook, inbound
      // WhatsApp/email, call routing) — the timeline and the admin Activity
      // Log both render it, so a hand-entered lead is visibly hand-entered.
      metadata: { source: input.source, returning: isReturning, manual: Boolean(actor) },
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
