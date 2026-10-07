import { prisma } from "./prisma";
import { logger } from "./logger";
import { getMailbox } from "./mailboxes";
import { sendEmail } from "./mailer";
import { personalizeTemplate } from "./message-templates";
import { isWithinSchedule } from "./whatsapp-autoreply";
import { getObjectBuffer } from "./storage";

/**
 * Onboarding welcome email — sent automatically when a NEW guest's email
 * address first enters the CRM through inbound mail (unknown sender, website
 * form, or medical form). One singleton config (subject/body/toggle, managed
 * from the Auto-Reply page), always sent from the sales mailbox
 * (hello@trewellness.in) regardless of which mailbox the inbound arrived on.
 *
 * Fires only on guest CREATION — a returning guest, a revived guest, or a
 * second email from the same address never re-triggers it, so no cooldown
 * bookkeeping is needed the way WhatsApp auto-replies need one.
 */

export interface WelcomeEmailSettingDTO {
  enabled: boolean;
  subject: string;
  body: string;
  /** Daily IST active window — same semantics as AutoReply's. */
  activeFromMin: number | null;
  activeToMin: number | null;
  /** Optional library file attached to every welcome email. */
  attachmentDocumentId: string | null;
  attachment: { id: string; filename: string; mimeType: string; sizeBytes: number } | null;
  /** The address it sends from — surfaced so the settings UI can show it. */
  fromAddress: string | null;
  updatedAt: string | null;
}

const ATTACHMENT_INCLUDE = {
  attachmentDocument: { select: { id: true, filename: true, mimeType: true, sizeBytes: true } },
} as const;

const DEFAULT_SUBJECT = "Welcome to Trē Wellness";
const DEFAULT_BODY =
  "Hello {name},\n\nWelcome to Trē Wellness \u{1F33F}\n\nThank you for reaching out to us. " +
  "To explore our retreats and offerings, visit https://trewellness.in — we'll get back to you shortly!\n\nTeam Trē Wellness";

export async function getWelcomeEmailSetting(): Promise<WelcomeEmailSettingDTO> {
  const row = await prisma.welcomeEmailSetting.findUnique({
    where: { id: "singleton" },
    include: ATTACHMENT_INCLUDE,
  });
  return {
    enabled: row?.enabled ?? false,
    subject: row?.subject ?? DEFAULT_SUBJECT,
    body: row?.body ?? DEFAULT_BODY,
    activeFromMin: row?.activeFromMin ?? null,
    activeToMin: row?.activeToMin ?? null,
    attachmentDocumentId: row?.attachmentDocumentId ?? null,
    attachment: row?.attachmentDocument ?? null,
    fromAddress: getMailbox("sales")?.address ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export async function updateWelcomeEmailSetting(input: {
  enabled: boolean;
  subject: string;
  body: string;
  activeFromMin?: number | null;
  activeToMin?: number | null;
  attachmentDocumentId?: string | null;
  updatedBy: string;
}): Promise<WelcomeEmailSettingDTO> {
  const data = {
    ...input,
    activeFromMin: input.activeFromMin ?? null,
    activeToMin: input.activeToMin ?? null,
    attachmentDocumentId: input.attachmentDocumentId ?? null,
  };
  const row = await prisma.welcomeEmailSetting.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...data },
    update: data,
    include: ATTACHMENT_INCLUDE,
  });
  return {
    enabled: row.enabled,
    subject: row.subject,
    body: row.body,
    activeFromMin: row.activeFromMin,
    activeToMin: row.activeToMin,
    attachmentDocumentId: row.attachmentDocumentId,
    attachment: row.attachmentDocument ?? null,
    fromAddress: getMailbox("sales")?.address ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Called by the inbound-mail poller right after it creates a brand-new guest
 * with a known email address. Best-effort: any failure is logged and
 * swallowed, never thrown, so it can never break inbound message storage.
 *
 * Resolves true only if a welcome email actually went out. The caller uses
 * that to decide whether a trigger auto-reply should still be sent, and it
 * used to decide on "is this a new guest" instead — with the welcome email
 * switched off, every new guest's auto-reply was being suppressed in favour
 * of a welcome email that never sent.
 */
export async function maybeSendWelcomeEmail(params: {
  guestId: string;
  enquiryId?: string | null;
  to: string;
}): Promise<boolean> {
  const { guestId, enquiryId, to } = params;
  try {
    const setting = await prisma.welcomeEmailSetting.findUnique({
      where: { id: "singleton" },
      include: { attachmentDocument: true },
    });
    if (!setting?.enabled) return false;
    if (!isWithinSchedule(setting.activeFromMin, setting.activeToMin)) return false;

    const mailbox = getMailbox("sales");
    if (!mailbox?.configured) {
      logger.warn({ guestId }, "welcome email: sales mailbox not configured, skipping");
      return false;
    }

    const guest = await prisma.guest.findUnique({
      where: { id: guestId },
      select: { fullName: true, gender: true },
    });
    const vars = { name: guest?.fullName ?? "there", gender: guest?.gender ?? null };
    const subject = personalizeTemplate(setting.subject, vars);
    const body = personalizeTemplate(setting.body, vars);

    const base = {
      guestId,
      enquiryId: enquiryId ?? null,
      mailboxId: mailbox.id,
      channel: "email" as const,
      direction: "outbound" as const,
      subject,
      body,
      fromEmail: mailbox.address,
      toEmail: to,
      attachmentDocumentId: setting.attachmentDocumentId,
    };

    try {
      const doc = setting.attachmentDocument;
      const attachments = doc
        ? [{
            filename: doc.filename,
            content: await getObjectBuffer(doc.storageKey),
            contentType: doc.mimeType,
          }]
        : undefined;
      const res = await sendEmail(mailbox, { to, subject, text: body, attachments });
      await prisma.message.create({ data: { ...base, messageId: res.messageId, status: "sent" } });
    } catch (err) {
      logger.error({ err, guestId, to }, "welcome email send failed");
      await prisma.message.create({
        data: { ...base, status: "failed", errorDetail: err instanceof Error ? err.message : "send failed" },
      });
      return false;
    }

    await prisma.activity.create({
      data: {
        guestId,
        enquiryId: enquiryId ?? null,
        actorSub: "email-welcome",
        actorRole: "system",
        actorName: "Welcome email",
        actionType: "message_sent",
        metadata: { channel: "email", mailbox: mailbox.id, welcome: true, to },
      },
    });
    logger.info({ guestId, to }, "welcome email sent");
    return true;
  } catch (err) {
    // If this throws after sendEmail succeeded (e.g. writing the Activity
    // row), the guest may have received it; reporting false risks a second
    // machine email, reporting true risks none. The auto-reply is the one the
    // guest actually asked for, so err towards sending it.
    logger.error({ err, guestId }, "welcome email failed");
    return false;
  }
}
