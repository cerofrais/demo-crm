import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { createEnquiry } from "./enquiry-service";
import { reviveEnquiryIfDeleted } from "./enquiries";
import { configuredMailboxes, type MailboxConfig } from "./mailboxes";
import { formatWebsiteFormNotes, parseWebsiteFormEmail, type WebsiteFormLead } from "./website-form-parser";
import { formatMedicalFormNotes, parseMedicalScreeningForm, type MedicalFormSubmission } from "./medical-form-parser";
import { upsertHealthRecordBackfill } from "./health-ingest";

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
): Promise<{ guestId: string; enquiryId?: string; needsReview: boolean }> {
  const note = formatWebsiteFormNotes(form);
  try {
    const result = await createEnquiry({
      fullName: form.fullName,
      phone: form.phone ?? undefined,
      email: form.email ?? undefined,
      city: form.city ?? undefined,
      source: "website_form",
      note,
    });
    return {
      guestId: result.enquiry.guest.id,
      enquiryId: result.enquiry.id,
      needsReview: false,
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
 */
async function resolveMedicalFormGuest(
  submission: MedicalFormSubmission,
): Promise<{ guestId: string; enquiryId?: string; needsReview: boolean }> {
  const { contact, health } = submission;
  const phone = contact.phone!; // parseMedicalScreeningForm() requires this to be non-null

  const existing = await prisma.guest.findFirst({
    where: { phone, deletedAt: null },
    select: {
      id: true,
      email: true,
      city: true,
      gender: true,
      dateOfBirth: true,
      enquiries: { orderBy: { lastActivityAt: "desc" }, take: 1, select: { id: true } },
    },
  });

  if (existing) {
    await prisma.guest.update({
      where: { id: existing.id },
      data: {
        isReturning: true,
        email: existing.email ?? contact.email ?? undefined,
        city: existing.city ?? contact.city ?? undefined,
        gender: existing.gender ?? contact.gender ?? undefined,
        dateOfBirth: existing.dateOfBirth ?? (contact.dateOfBirth ? new Date(contact.dateOfBirth) : undefined),
      },
    }).catch((err) => logger.error({ err, guestId: existing.id }, "medical-form: guest backfill failed"));
    await upsertHealthRecordBackfill(existing.id, health).catch((err) =>
      logger.error({ err, guestId: existing.id }, "medical-form: health backfill failed"),
    );
    return { guestId: existing.id, enquiryId: existing.enquiries[0]?.id, needsReview: false };
  }

  // Genuinely new phone number — a real lead, with whatever basic info the
  // form provided; the two fields with no home on Guest or HealthRecord
  // (father/spouse name, how they heard about us) go into intakeNotes so
  // nothing from the submission is silently dropped.
  const note = formatMedicalFormNotes(contact);
  const gender = contact.gender === "male" || contact.gender === "female" || contact.gender === "other"
    ? contact.gender
    : undefined;
  try {
    const result = await createEnquiry({
      fullName: contact.fullName,
      phone,
      email: contact.email ?? undefined,
      city: contact.city ?? undefined,
      gender,
      source: "email",
      note,
    });
    if (contact.dateOfBirth) {
      await prisma.guest.update({
        where: { id: result.enquiry.guest.id },
        data: { dateOfBirth: new Date(contact.dateOfBirth) },
      }).catch((err) => logger.error({ err }, "medical-form: dateOfBirth backfill failed"));
    }
    await upsertHealthRecordBackfill(result.enquiry.guest.id, health).catch((err) =>
      logger.error({ err, guestId: result.enquiry.guest.id }, "medical-form: health backfill failed"),
    );
    return { guestId: result.enquiry.guest.id, enquiryId: result.enquiry.id, needsReview: false };
  } catch (err) {
    logger.error({ err, phone }, "medical-form auto-enquiry failed; falling back to guest-only capture");
    const guest = await prisma.guest.upsert({
      where: { phone },
      update: {},
      create: { fullName: contact.fullName, phone, email: contact.email ?? undefined, city: contact.city ?? undefined },
      select: { id: true },
    });
    await upsertHealthRecordBackfill(guest.id, health).catch(() => {});
    return { guestId: guest.id, needsReview: true };
  }
}

async function resolveGuestId(
  mailbox: MailboxConfig,
  parsed: ParsedMail,
  fromEmail: string | null,
  text: string,
): Promise<{ guestId: string; enquiryId?: string; needsReview: boolean }> {
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
    if (submission) return resolveMedicalFormGuest(submission);
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
    const guest = await prisma.guest.findFirst({
      where: { email: fromEmail, deletedAt: null },
      select: {
        id: true,
        enquiries: { orderBy: { lastActivityAt: "desc" }, take: 1, select: { id: true } },
      },
    });
    if (guest) {
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
    };
  } catch (err) {
    logger.error({ err, mailbox: mailbox.id, fromEmail }, "inbound auto-enquiry failed; falling back to guest-only capture");
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
    const blockedGuest = await prisma.guest.findFirst({
      where: { email: fromEmail, deletedAt: null, isBlocked: true },
      select: { id: true },
    });
    if (blockedGuest) {
      logger.info({ mailbox: mailbox.id, fromEmail }, "inbound email: sender is a blocked guest, ignoring");
      return;
    }
  }

  const text = parsed.text?.trim() || htmlToText(parsed.html || undefined);
  const { guestId, enquiryId, needsReview } = await resolveGuestId(mailbox, parsed, fromEmail, text);

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
      const isNewAccount = state.lastUid === 0 || (uidValidity != null && state.uidValidity !== uidValidity);
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
