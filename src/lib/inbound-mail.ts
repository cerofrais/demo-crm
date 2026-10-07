import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { createEnquiry } from "./enquiry-service";
import { reviveEnquiryIfDeleted } from "./enquiries";
import { reviveGuestIfDeleted } from "./guest-revive";
import { configuredMailboxes, type MailboxConfig } from "./mailboxes";
import {
  formatWebsiteFormNotes,
  parseLandingPageForm,
  parseWebsiteFormEmail,
  parseFormDate,
  type WebsiteFormLead,
} from "./website-form-parser";
import { ageToDateOfBirth } from "./utils";
import { packageTag } from "./lead-tags";
import { routeMedicalForm } from "./lead-assignment";
import { reassignTasksForEnquiry } from "./tasks";
import { formatMedicalFormNotes, parseMedicalScreeningForm, type MedicalFormSubmission } from "./medical-form-parser";
import { createHealthRecordFromForm } from "./health-ingest";
import { maybeSendWelcomeEmail } from "./welcome-email";
import { maybeSendEmailAutoReply } from "./email-autoreply";
import { applyEmailAutoTags } from "./email-auto-tag";
import { realAttachmentNames } from "./email-attachments";
import { applyReplyTag } from "./reply-tag";
import { createDoctorReviewTask } from "./tasks";
import { syncEnquiryTags } from "./tags-service";

/** The mailer's subject is stable — anchoring on it (not sniffing the body,
 *  which has no colons for the generic website-form label-scanner to key
 *  off) is both simpler and more precise. */
const MEDICAL_FORM_SUBJECT_SUBSTRING = "Pre-Booking Guest Medical Screening Form";

/**
 * Inbound email → conversations + leads.
 *
 * Polls each configured mailbox over IMAP, threads replies back to the right
 * guest, and (for the sales mailbox) auto-creates a lead for unknown senders.
 * Never marks messages read — a per-mailbox UID cursor (MailboxState) tracks
 * progress so staff can still read the inbox directly.
 */

function normalizeRefs(refs: ParsedMail["references"]): string[] {
  if (!refs) return [];
  return Array.isArray(refs) ? refs : [refs];
}

function htmlToText(html?: string): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * trewellness.in's contact-form notification emails always arrive
 * hello@trewellness.in -> hello@trewellness.in (the site's mailer sends "as"
 * its own recipient) — the real customer's contact info only ever appears in
 * the body. Using the SMTP From header here would attach every single form
 * submission, from every different customer, to one "hello@trewellness.in"
 * guest record. createEnquiry() still does its normal returning-guest
 * recognition (by the extracted phone/email), so a repeat submission from
 * the same customer correctly reuses their guest record instead of the
 * inbox's.
 */
async function resolveWebsiteFormLead(
  form: WebsiteFormLead,
): Promise<{ guestId: string; enquiryId?: string; needsReview: boolean; welcomeTo?: string | null }> {
  const note = formatWebsiteFormNotes(form);
  // "Package Preference: Mini Detox" -> a package:mini-detox tag on the card,
  // so it's filterable/visible at a glance instead of buried in intake notes
  // (where it still appears, alongside the fields that have no column).
  const pkgTag = form.package ? packageTag(form.package) : null;
  // Only a parseable date reaches the column; anything else ("flexible",
  // "mid-August") stays in the notes rather than being guessed at.
  const checkIn = form.checkinDate ? parseFormDate(form.checkinDate) : null;
  try {
    const result = await createEnquiry({
      fullName: form.fullName,
      phone: form.phone ?? undefined,
      email: form.email ?? undefined,
      city: form.city ?? undefined,
      businessName: form.businessName ?? undefined,
      businessRole: form.businessRole ?? undefined,
      source: "website_form",
      preferredCheckIn: checkIn,
      // Self-reported, not a real DOB — only ever backfills a guest that has
      // none yet (see createEnquiry), so a more precise DOB from elsewhere
      // (e.g. the medical screening form) is never clobbered by this.
      dateOfBirth: form.age != null ? ageToDateOfBirth(form.age) : undefined,
      enquiryTags: pkgTag ? [pkgTag] : undefined,
      // A programme landing page ("Sleep Restoration") is effectively its own
      // campaign — labelled so its leads can be filtered, routed and
      // reported on like any ad campaign's.
      campaignLabel: form.program ?? undefined,
      note,
    });
    return {
      guestId: result.enquiry.guest.id,
      enquiryId: result.enquiry.id,
      needsReview: false,
      // Welcome only for a guest this submission genuinely CREATED — a
      // returning guest (matched by phone or email) has been written to
      // before and shouldn't get an onboarding email again.
      welcomeTo: result.returning.isReturning ? null : form.email,
    };
  } catch (err) {
    logger.error({ err, email: form.email }, "website-form auto-enquiry failed; falling back to guest-only capture");
    const guest = form.email
      ? await prisma.guest.upsert({
          where: { email: form.email },
          update: {},
          create: { fullName: form.fullName, email: form.email, phone: form.phone ?? undefined },
          select: { id: true },
        })
      : await prisma.guest.create({
          data: { fullName: form.fullName, phone: form.phone ?? undefined },
          select: { id: true },
        });
    return { guestId: guest.id, needsReview: true };
  }
}


/**
 * Stages at or past the doctor's desk. A screening form arriving for a lead
 * already in one of these must not drag it backwards — a guest who has
 * already paid or checked in can still submit (or re-submit) the form, and
 * pulling their card back to Doctor Consultation would undo real progress and
 * re-raise a review the doctor has already given.
 */
const AT_OR_PAST_DOCTOR = new Set([
  "doctor_consultation",
  "payment_received",
  "booking_confirmed",
  "converted",
]);

/** Whether a screening form arriving for a lead in `stage` should move it to
 *  Doctor Consultation. Exported for the tests — the rule is the whole
 *  feature, and getting it wrong either strands a form or rewinds a booking. */
export function shouldMoveToDoctorConsultation(stage: string): boolean {
  return !AT_OR_PAST_DOCTOR.has(stage);
}

/**
 * Move a returning guest's existing lead to Doctor Consultation on receipt of
 * their medical screening form.
 *
 * The form is the input the doctor is waiting on, so its arrival is exactly
 * the moment the card belongs in that column. Before this it stayed wherever
 * it was and someone had to notice the email and drag it across.
 *
 * Deliberately moves a lead out of Lost and Staff too: submitting the
 * pre-booking screening form is about the strongest intent signal there is,
 * and a re-engaging guest sitting in Lost is precisely the one nobody is
 * looking at.
 *
 * Carries the same side effects as a manual move (lib/../stage/route.ts) —
 * the stage_change timeline entry, the doctor-review task, and a tag re-sync
 * — so a lead that lands here automatically is indistinguishable from one
 * dragged across by hand. createDoctorReviewTask is itself idempotent: a
 * second form submission won't raise a second review.
 */
// Exported for scripts/backfill-screening-form-doctor-stage.ts, so a lead
// moved after the fact takes the identical path — same guards, same
// stage_change entry, same doctor-review task — as one moved on arrival.
export async function moveToDoctorConsultation(
  lead: { id: string; stage: string; deletedAt: Date | null },
  guestId: string,
  guestName: string,
): Promise<void> {
  if (!shouldMoveToDoctorConsultation(lead.stage)) return;

  // The guest is revived above; their ticket has to come back with them or
  // the move writes to a card nobody can see.
  if (lead.deletedAt) await reviveEnquiryIfDeleted(lead.id);

  await prisma.enquiry.update({
    where: { id: lead.id },
    data: {
      stage: "doctor_consultation",
      lastActivityAt: new Date(),
      // Same as the manual path: leaving Lost clears the timestamp that put
      // it there, so the dead-lead sweep doesn't re-collect it.
      ...(lead.stage === "lost" ? { lostAt: null } : {}),
    },
  });

  await prisma.activity.create({
    data: {
      enquiryId: lead.id,
      guestId,
      actorSub: "inbound-mail",
      actorRole: "system",
      actorName: "Medical screening form",
      actionType: "stage_change",
      metadata: { from: lead.stage, to: "doctor_consultation" },
    },
  });

  await createDoctorReviewTask(lead.id, guestName, "inbound-mail");
  await syncEnquiryTags(lead.id);

  logger.info(
    { enquiryId: lead.id, from: lead.stage },
    "medical-form: moved existing lead to doctor consultation",
  );
}

/**
 * "Pre-Booking Guest Medical Screening Form" submission — a genuinely
 * different shape from every other inbound email this poller handles: it
 * exists purely to fill in a guest's health record, not to open a fresh
 * conversation. Matched by phone (the form's own "Mobile Number" field, not
 * the SMTP envelope — same reasoning as resolveWebsiteFormLead: the site's
 * mailer sends every submission "as" hello@trewellness.in).
 *
 * An existing guest is never given a new lead ticket for this — only their
 * health record (backfilled, never overwritten — see health-ingest.ts) and
 * demographic gaps are filled, and the email still attaches to whichever
 * enquiry they already have (if any) so it's visible in that lead's
 * timeline. Only a genuinely new phone number opens a new lead.
 *
 * EITHER WAY the lead ends up in Doctor Consultation: this form is the input
 * the doctor waits on, and whether the number is one we have seen before has
 * no bearing on that. See moveToDoctorConsultation.
 */
/**
 * The form's email address, but only when no OTHER guest already owns it.
 *
 * Guest.email is unique. A screening form filled in on a relative's or an
 * assistant's address collides with whoever holds it, and BOTH create paths
 * below used to pass the address through regardless — so the insert died on
 * P2002 and the whole submission, health answers included, was dropped.
 * Four real forms were lost this way (Uma Srikonda, Lala Atasi Roy, Shirley
 * Seah, and Archana Purini's second number).
 *
 * The phone is the identity on a screening form, so the address is what
 * gives way: the guest is created without it rather than not at all.
 */
async function emailFreeForNewGuest(email: string | null): Promise<string | undefined> {
  if (!email) return undefined;
  const owner = await prisma.guest.findFirst({ where: { email }, select: { id: true } });
  if (!owner) return email;
  logger.warn({ email }, "medical-form: email already belongs to another guest — creating without it");
  return undefined;
}

/**
 * Hand a lead to whoever the pre-arrival rule names, when it says to.
 *
 * A form means the guest is nearly here and the work becomes Front Office's.
 * But taking a card off the rep who has been talking to them is a real
 * intervention, so it only happens when an admin has ticked that box — the
 * rule with the box unticked still routes NEW leads from forms, and leaves
 * everything already owned exactly where it is.
 */
async function handOverToFormTeam(enquiryId: string, guestId: string): Promise<void> {
  const routing = await routeMedicalForm();
  if (!routing.assignee || !routing.reassignExisting) return;

  const lead = await prisma.enquiry.findUnique({
    where: { id: enquiryId },
    select: { assignedToSub: true, assignedToName: true },
  });
  if (!lead || lead.assignedToSub === routing.assignee.sub) return;

  await prisma.enquiry.update({
    where: { id: enquiryId },
    data: { assignedToSub: routing.assignee.sub, assignedToName: routing.assignee.name },
  });
  // The lead's own open follow-ups go with it; a task left pointing at the
  // previous owner is how a chase gets dropped.
  await reassignTasksForEnquiry(enquiryId, routing.assignee.sub);
  await prisma.activity.create({
    data: {
      enquiryId,
      guestId,
      actorSub: "inbound-mail",
      actorRole: "system",
      actorName: "Pre-arrival form",
      actionType: "assign",
      metadata: { from: lead.assignedToName ?? "Unassigned", to: routing.assignee.name },
    },
  });
}

async function resolveMedicalFormGuest(
  submission: MedicalFormSubmission,
  sourceMessageId: string | null,
): Promise<{ guestId: string; enquiryId?: string; needsReview: boolean; welcomeTo?: string | null }> {
  const { contact, health } = submission;
  const phone = contact.phone!; // parseMedicalScreeningForm() requires this to be non-null

  // The record is about whoever the FORM names, which for a family sharing a
  // phone is not the guest this resolves to. Captured once and passed to
  // every write below so all three paths agree on the subject.
  const subject = { subjectName: contact.fullName, subjectPhone: phone, sourceMessageId };

  // Soft-deleted guests included — see resolveGuestId()'s note; the phone is
  // still unique against the hidden row, so a filtered miss becomes a P2002.
  const existing = await prisma.guest.findFirst({
    where: { phone },
    select: {
      id: true,
      fullName: true,
      deletedAt: true,
      email: true,
      city: true,
      gender: true,
      dateOfBirth: true,
      enquiries: {
        orderBy: { lastActivityAt: "desc" },
        take: 1,
        select: { id: true, stage: true, deletedAt: true },
      },
    },
  });

  if (existing) {
    if (existing.deletedAt) {
      await reviveGuestIfDeleted(existing.id, "medical screening form submitted");
    }
    await prisma.guest.update({
      where: { id: existing.id },
      data: {
        email: existing.email ?? contact.email ?? undefined,
        city: existing.city ?? contact.city ?? undefined,
        gender: existing.gender ?? contact.gender ?? undefined,
        dateOfBirth: existing.dateOfBirth ?? (contact.dateOfBirth ? new Date(contact.dateOfBirth) : undefined),
      },
    }).catch((err) => logger.error({ err, guestId: existing.id }, "medical-form: guest backfill failed"));
    await createHealthRecordFromForm({ guestId: existing.id, record: health, ...subject }).catch((err) =>
      logger.error({ err, guestId: existing.id }, "medical-form: health record write failed"),
    );
    const openLead = existing.enquiries[0];
    if (openLead) {
      await moveToDoctorConsultation(openLead, existing.id, existing.fullName).catch((err) =>
        logger.error({ err, enquiryId: openLead.id }, "medical-form: stage move failed"),
      );
      await handOverToFormTeam(openLead.id, existing.id).catch((err) =>
        logger.error({ err, enquiryId: openLead.id }, "medical-form: handover failed"),
      );
    }
    return { guestId: existing.id, enquiryId: openLead?.id, needsReview: false };
  }

  // Genuinely new phone number — a real lead, with whatever basic info the
  // form provided; the two fields with no home on Guest or HealthRecord
  // (father/spouse name, how they heard about us) go into intakeNotes so
  // nothing from the submission is silently dropped.
  const note = formatMedicalFormNotes(contact);
  const gender = contact.gender === "male" || contact.gender === "female" || contact.gender === "other"
    ? contact.gender
    : undefined;
  const usableEmail = await emailFreeForNewGuest(contact.email);
  // A pre-arrival form is Front Office's job, not the Incoming Email pool's —
  // see the medical_form rule on the Lead Assignment page. Unset, this is
  // null and the lead routes exactly as it did before.
  const routing = await routeMedicalForm().catch((err) => {
    logger.warn({ err }, "medical-form: assignment rule lookup failed");
    return { assignee: null, reassignExisting: false };
  });
  try {
    const result = await createEnquiry({
      fullName: contact.fullName,
      phone,
      email: usableEmail,
      city: contact.city ?? undefined,
      gender,
      source: "email",
      assignedTo: routing.assignee ?? undefined,
      note,
    });
    if (contact.dateOfBirth) {
      await prisma.guest.update({
        where: { id: result.enquiry.guest.id },
        data: { dateOfBirth: new Date(contact.dateOfBirth) },
      }).catch((err) => logger.error({ err }, "medical-form: dateOfBirth backfill failed"));
    }
    await createHealthRecordFromForm({ guestId: result.enquiry.guest.id, record: health, ...subject }).catch((err) =>
      logger.error({ err, guestId: result.enquiry.guest.id }, "medical-form: health record write failed"),
    );
    // Straight to the doctor, exactly as a returning guest's lead is. The
    // form is the input the doctor waits on, and whether we happen to have
    // seen this phone number before says nothing about that — a first-time
    // submitter is if anything more urgent, not less.
    //
    // Created first and moved second rather than opened directly in the
    // stage: createEnquiry owns the new_lead default, and going through the
    // same helper keeps the side effects identical to every other route into
    // that column — the stage_change entry, the doctor-review task and the
    // tag re-sync.
    await moveToDoctorConsultation(
      { id: result.enquiry.id, stage: result.enquiry.stage, deletedAt: null },
      result.enquiry.guest.id,
      result.enquiry.guest.fullName,
    ).catch((err) =>
      logger.error({ err, enquiryId: result.enquiry.id }, "medical-form: stage move failed"),
    );
    return {
      guestId: result.enquiry.guest.id,
      enquiryId: result.enquiry.id,
      needsReview: false,
      welcomeTo: result.returning.isReturning ? null : usableEmail ?? null,
    };
  } catch (err) {
    logger.error({ err, phone }, "medical-form auto-enquiry failed; falling back to guest-only capture");
    const guest = await prisma.guest.upsert({
      where: { phone },
      update: {},
      create: { fullName: contact.fullName, phone, email: usableEmail, city: contact.city ?? undefined },
      select: { id: true },
    });
    await createHealthRecordFromForm({ guestId: guest.id, record: health, ...subject }).catch(() => {});
    return { guestId: guest.id, needsReview: true };
  }
}

async function resolveGuestId(
  mailbox: MailboxConfig,
  parsed: ParsedMail,
  fromEmail: string | null,
  text: string,
): Promise<{ guestId: string; enquiryId?: string; needsReview: boolean; welcomeTo?: string | null }> {
  // 1) Thread match: In-Reply-To / References → one of our stored messages.
  // Always takes priority — a reply that happens to quote form-style text
  // shouldn't spawn a second lead instead of threading onto the original.
  const refIds = [
    ...(parsed.inReplyTo ? [parsed.inReplyTo] : []),
    ...normalizeRefs(parsed.references),
  ];
  if (refIds.length) {
    const prior = await prisma.message.findFirst({
      where: { mailboxId: mailbox.id, messageId: { in: refIds }, guestId: { not: null } },
      select: { guestId: true, enquiryId: true },
    });
    if (prior?.guestId) {
      return {
        guestId: prior.guestId,
        enquiryId: prior.enquiryId ?? undefined,
        needsReview: false,
      };
    }
  }

  // 2) A medical-screening-form submission — gated on the mailer's stable
  // subject line (see MEDICAL_FORM_SUBJECT_SUBSTRING), checked before the
  // website-form sniff below since it's a cheap, precise signal. Falls
  // through to normal handling if the subject matched but the body didn't
  // parse (unexpected format) rather than silently dropping the email.
  if (parsed.subject?.includes(MEDICAL_FORM_SUBJECT_SUBSTRING)) {
    const submission = parseMedicalScreeningForm(text);
    if (submission) return resolveMedicalFormGuest(submission, parsed.messageId ?? null);
  }

  // 3a) A programme landing-page form ("New Sleep Restoration Inquiry -
  // trewellness.in"). Identified by its subject, so it may be phone-only —
  // which the general parser below must never accept. Without this, these
  // all fell through to step 4 and landed on the site's own sender, the
  // "trē wellness" guest.
  const landingLead = parseLandingPageForm(parsed.subject, text);
  if (landingLead) {
    return resolveWebsiteFormLead(landingLead);
  }

  // 3) A recognized website-form submission — checked before the generic
  // sender-based lookup below since fromEmail is this mailbox's own address,
  // not the customer's (see resolveWebsiteFormLead's comment).
  const formLead = parseWebsiteFormEmail(text);
  if (formLead) {
    return resolveWebsiteFormLead(formLead);
  }

  // 4) Sender → existing guest by email.
  if (fromEmail) {
    // Soft-deleted guests included: they still own this address on the unique
    // index, so skipping them means a create that P2002s. Revive instead —
    // blocked senders were already dropped by processMessage().
    const guest = await prisma.guest.findFirst({
      where: { email: fromEmail },
      select: {
        id: true,
        deletedAt: true,
        enquiries: { orderBy: { lastActivityAt: "desc" }, take: 1, select: { id: true } },
      },
    });
    if (guest) {
      if (guest.deletedAt) await reviveGuestIfDeleted(guest.id, "inbound email");
      return {
        guestId: guest.id,
        enquiryId: guest.enquiries[0]?.id,
        needsReview: false,
      };
    }
  }

  // 5) Unknown sender.
  const fromName = parsed.from?.value?.[0]?.name?.trim();
  const displayName = fromName || fromEmail || "Unknown sender";

  // Unknown sender: always create a new enquiry/ticket (source=email), even for
  // non-sales mailboxes, so inbound strangers consistently land in the pipeline.
  // If lead creation fails, we still store the message on a review guest.
  try {
    const result = await createEnquiry({
      fullName: displayName,
      email: fromEmail ?? undefined,
      source: "email",
      note: parsed.subject ? `Inbound email: ${parsed.subject}` : "Inbound email",
    });
    return {
      guestId: result.enquiry.guest.id,
      enquiryId: result.enquiry.id,
      needsReview: false,
      welcomeTo: result.returning.isReturning ? null : fromEmail,
    };
  } catch (err) {
    logger.error({ err, mailbox: mailbox.id, fromEmail }, "inbound auto-enquiry failed; falling back to guest-only capture");
    // Matches on email alone, so it can land on a soft-deleted guest and file
    // the mail against a record nobody can see — revive, same as the WhatsApp
    // fallback.
    const guest = fromEmail
      ? await prisma.guest.upsert({
          where: { email: fromEmail },
          update: {},
          create: { fullName: displayName, email: fromEmail },
          select: { id: true },
        })
      : await prisma.guest.create({
          data: { fullName: displayName },
          select: { id: true },
        });
    if (fromEmail) {
      await reviveGuestIfDeleted(guest.id, "inbound email (enquiry creation failed)");
    }
    return { guestId: guest.id, needsReview: true };
  }
}

async function processMessage(mailbox: MailboxConfig, source: Buffer): Promise<void> {
  const parsed = await simpleParser(source);
  const messageId = parsed.messageId ?? null;

  // Dedup — idempotent across re-polls.
  if (messageId) {
    const exists = await prisma.message.findUnique({ where: { messageId } });
    if (exists) return;
  }

  const fromEmail = parsed.from?.value?.[0]?.address?.toLowerCase() ?? null;

  // A blocked guest's incoming email is dropped here, before anything is
  // stored — checked directly against fromEmail rather than through
  // resolveGuestId, since blocking only ever applies to a guest that
  // already exists. Same reasoning/placement as the WhatsApp webhook's
  // equivalent check.
  if (fromEmail) {
    // No deletedAt filter — a guest blocked and then soft-deleted stays
    // blocked, and never reaches the revive in resolveGuestId(). Same
    // reasoning as the WhatsApp webhook's equivalent check.
    const blockedGuest = await prisma.guest.findFirst({
      where: { email: fromEmail, isBlocked: true },
      select: { id: true },
    });
    if (blockedGuest) {
      logger.info({ mailbox: mailbox.id, fromEmail }, "inbound email: sender is a blocked guest, ignoring");
      return;
    }
  }

  const text = parsed.text?.trim() || htmlToText(parsed.html || undefined);
  const { guestId, enquiryId, needsReview, welcomeTo } = await resolveGuestId(mailbox, parsed, fromEmail, text);

  // The matched enquiry may be soft-deleted (resolveGuestId doesn't filter
  // it out) — revive it rather than silently attaching this message to a
  // hidden ticket.
  if (enquiryId) await reviveEnquiryIfDeleted(enquiryId).catch(() => {});

  await prisma.message.create({
    data: {
      guestId,
      enquiryId: enquiryId ?? null,
      mailboxId: mailbox.id,
      channel: "email",
      direction: "inbound",
      subject: parsed.subject ?? null,
      body: text || "(no text content)",
      bodyHtml: typeof parsed.html === "string" ? parsed.html : null,
      fromEmail,
      toEmail: mailbox.address,
      messageId,
      inReplyTo: parsed.inReplyTo ?? null,
      references: [
        ...(parsed.inReplyTo ? [parsed.inReplyTo] : []),
        ...normalizeRefs(parsed.references),
      ],
      // Names only — the files themselves are not stored. Enough for the
      // conversation to show that something was attached, and what.
      attachmentNames: realAttachmentNames(parsed.attachments),
      status: "received",
      needsReview,
    },
  });

  await prisma.activity.create({
    data: {
      guestId,
      enquiryId: enquiryId ?? null,
      actorSub: "inbound",
      actorRole: "system",
      actorName: fromEmail ?? "Inbound",
      actionType: "message_received",
      metadata: { channel: "email", mailbox: mailbox.id, subject: parsed.subject ?? "" },
    },
  });

  // Flag the enquiry so the card lights up on the Kanban board.
  // Only for existing enquiries (new leads are already visible as new_lead cards).
  if (enquiryId && !needsReview) {
    await prisma.enquiry.update({
      where: { id: enquiryId },
      data: { needsAttention: true, lastActivityAt: new Date() },
    }).catch(() => null);
  }

  // A guest answering a tagged bulk email earns that tag on their lead.
  // Email threading (In-Reply-To/References) makes this an exact match in
  // the common case. Never throws.
  await applyReplyTag({
    guestId,
    enquiryId,
    channel: "email",
    inReplyTo: parsed.inReplyTo ?? null,
    references: normalizeRefs(parsed.references),
  });

  // Keyword auto-tags from the subject and body. Before the auto-reply so the
  // tags are on the lead even if sending later fails. Never throws.
  await applyEmailAutoTags({
    mailboxId: mailbox.id,
    guestId,
    enquiryId,
    subject: parsed.subject ?? "",
    body: text,
  });

  // Onboarding welcome — only when this very email brought a brand-new
  // guest into the CRM (welcomeTo is null/undefined in every other case).
  // After the inbound Message row, so their thread reads in real order.
  let welcomeSent = false;
  if (welcomeTo) {
    welcomeSent = await maybeSendWelcomeEmail({ guestId, enquiryId, to: welcomeTo });
  }

  // Trigger-word auto-reply. LAST, and only after the inbound row exists —
  // the reply's own row is written against it, and the cooldown that stops a
  // loop is a query over exactly those rows. Never throws.
  //
  // The reply is held back only when a welcome email ACTUALLY went out, so a guest never gets
  // two machine-written messages in the same second. It used to be skipped
  // for every brand-new guest — and with the welcome email switched off, that
  // silently swallowed the auto-reply for exactly the people most likely to
  // trigger one: first-time enquirers asking for a sample itinerary.
  // Always called, so a matching rule can still tag the lead; it is only the
  // reply that is held back when a welcome email has just gone out.
  await maybeSendEmailAutoReply({
    mailboxId: mailbox.id,
    parsed,
    fromEmail,
    body: text,
    guestId,
    enquiryId,
    inReplyToMessageId: messageId,
    welcomeSent,
  });

  logger.info({ mailbox: mailbox.id, fromEmail, needsReview }, "inbound email stored");
}

async function pollMailbox(mailbox: MailboxConfig): Promise<void> {
  const client = new ImapFlow({
    host: mailbox.imap.host,
    port: mailbox.imap.port,
    secure: true,
    auth: { user: mailbox.imap.user, pass: mailbox.imap.pass },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const state = await prisma.mailboxState.upsert({
        where: { mailboxId: mailbox.id },
        update: {},
        create: { mailboxId: mailbox.id, folder: "INBOX", lastUid: 0 },
      });

      const box = client.mailbox;
      const uidNext = (box && typeof box !== "boolean" && box.uidNext) || 1;
      const uidValidity = box && typeof box !== "boolean" ? (box.uidValidity ?? null) : null;

      // UIDs are only comparable within one (server, UIDVALIDITY) pair. If
      // the mailboxId's env creds got repointed at a different account (or
      // this is the first run), the stored lastUid is either 0 or meaningless
      // in this account's UID space — re-anchor to the current tip instead of
      // treating everything since lastUid as unread, or a creds swap imports
      // the whole new inbox as leads.
      // A cursor PAST the mailbox tip can never match anything: the fetch
      // range is `lastUid + 1:*`, so polling returns nothing for ever with no
      // error and no log, and inbound email just stops.
      //
      // REFUSE TO POLL rather than re-anchor. The overwhelmingly likely cause
      // is that these credentials point at the wrong account — a restored or
      // synced database brings MailboxState with it while the env stays put —
      // and the cursor is perfectly valid for the mailbox it came from.
      // Re-anchoring to this (wrong) mailbox's tip would throw that cursor
      // away for good; pointing the credentials back afterwards would then
      // re-ingest the entire account as new leads. Both happened here: a
      // cursor of 4917 was correct for a mailbox with uidNext 5030, and got
      // overwritten with 117 by the account the env had drifted onto.
      //
      // Stopping is safe and reversible: fix the credentials and the next
      // poll resumes exactly where it left off.
      if (state.lastUid >= uidNext) {
        logger.error(
          { mailbox: mailbox.id, lastUid: state.lastUid, uidNext },
          "inbound poll: stored cursor is beyond this mailbox's newest UID — " +
            "refusing to poll. These credentials almost certainly point at a " +
            "different account than the cursor came from; check the mailbox's " +
            "IMAP user. The cursor is left untouched.",
        );
        return;
      }

      const isNewAccount =
        state.lastUid === 0 || (uidValidity != null && state.uidValidity !== uidValidity);
      if (isNewAccount) {
        await prisma.mailboxState.update({
          where: { mailboxId: mailbox.id },
          data: { lastUid: Math.max(0, uidNext - 1), uidValidity },
        });
        // uidValidity is a bigint — pino's JSON serializer can't handle that,
        // so log it as a Number (IMAP UIDVALIDITY is 32-bit, well within safe range).
        logger.info(
          { mailbox: mailbox.id, anchorUid: uidNext - 1, uidValidity: uidValidity != null ? Number(uidValidity) : null },
          "inbound poll anchored",
        );
        return;
      }

      let maxUid = state.lastUid;
      const range = `${state.lastUid + 1}:*`;
      for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
        if (msg.uid <= state.lastUid) continue;
        if (msg.source) {
          try {
            await processMessage(mailbox, msg.source as Buffer);
          } catch (err) {
            logger.error({ err, uid: msg.uid, mailbox: mailbox.id }, "inbound process failed");
          }
        }
        if (msg.uid > maxUid) maxUid = msg.uid;
      }

      if (maxUid > state.lastUid) {
        await prisma.mailboxState.update({
          where: { mailboxId: mailbox.id },
          data: { lastUid: maxUid },
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

let polling = false;

/** Poll every configured mailbox once (guards against overlapping runs). */
export async function pollInbound(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    for (const mailbox of configuredMailboxes()) {
      try {
        await pollMailbox(mailbox);
      } catch (err) {
        logger.error({ err, mailbox: mailbox.id }, "mailbox poll failed");
      }
    }
  } finally {
    polling = false;
  }
}
