import nodemailer, { type Transporter } from "nodemailer";
import crypto from "node:crypto";
import type { MailboxConfig } from "./mailboxes";
import { logger } from "./logger";

/**
 * Outbound email via the mailbox's own SMTP (nodemailer). One transport per
 * mailbox, cached. Works the same in dev (Gmail SMTP) and prod (Workspace).
 */
const transports = new Map<string, Transporter>();

function transportFor(mailbox: MailboxConfig): Transporter {
  const cached = transports.get(mailbox.id);
  if (cached) return cached;
  const hasAuth = Boolean(mailbox.smtp.user && mailbox.smtp.pass);
  const t = nodemailer.createTransport({
    host: mailbox.smtp.host,
    port: mailbox.smtp.port,
    secure: mailbox.smtp.secure, // false for 587 (STARTTLS), true for 465
    // STARTTLS for real providers; allow plain for a local dev sink (Mailhog).
    requireTLS: hasAuth && !mailbox.smtp.secure,
    ...(hasAuth ? { auth: { user: mailbox.smtp.user, pass: mailbox.smtp.pass } } : {}),
  });
  transports.set(mailbox.id, t);
  return t;
}

/** RFC 5322 Message-ID anchored to the mailbox's domain. */
export function makeMessageId(fromAddress: string): string {
  const domain = fromAddress.split("@")[1] ?? "tre-crm.local";
  return `<${crypto.randomUUID()}@${domain}>`;
}

export interface SendArgs {
  to: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: { filename: string; content: Buffer; contentType?: string; cid?: string }[];
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  response: string;
}

export async function sendEmail(
  mailbox: MailboxConfig,
  args: SendArgs,
): Promise<SendResult> {
  const messageId = makeMessageId(mailbox.address);
  const info = await transportFor(mailbox).sendMail({
    from: mailbox.from,
    replyTo: mailbox.from,
    to: args.to,
    subject: args.subject,
    text: args.text,
    html: args.html,
    messageId,
    inReplyTo: args.inReplyTo ?? undefined,
    references: args.references?.length ? args.references.join(" ") : undefined,
    attachments: args.attachments,
  });
  logger.info(
    { mailbox: mailbox.id, to: args.to, messageId },
    "email sent",
  );
  return {
    messageId,
    accepted: (info.accepted ?? []).map(String),
    response: info.response ?? "",
  };
}
