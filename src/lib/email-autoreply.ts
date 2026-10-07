/**
 * Trigger-word auto-reply for inbound email — the sibling of
 * whatsapp-autoreply.ts, and it reuses that module's matchAutoReply() and
 * isWithinSchedule() so the two behave identically where a rep configures
 * them identically.
 *
 * WHAT IS DIFFERENT IS THE DANGER.
 * Two email auto-responders pointed at each other send forever, and ours
 * would be one of them. Worse, in this CRM specifically: 1,240 of 1,398
 * inbound emails are FROM our own address, because the website form mailer
 * posts as hello@trewellness.in. An auto-reply that answered those would
 * reply to itself on the very next poll — a loop that saturates the Gmail
 * quota and gets the domain rate-limited within minutes.
 *
 * So shouldAutoReply() is the important function here, not the sending. Its
 * checks are, in order of how badly each one bites:
 *   1. our own addresses            — the self-loop above
 *   2. anything else on our domain  — wp@ and ma@ are internal mailers, not
 *                                     guests, and staff need no auto-reply
 *   3. auto-generated mail          — RFC 3834 headers, and the daemon/
 *                                     no-reply address conventions
 *   4. a recent reply to this sender — bounded even if the rest all miss
 * On top of that every reply we send carries Auto-Submitted: auto-replied,
 * which is what stops a correspondent's responder answering ours.
 */
import type { ParsedMail } from "mailparser";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { getMailbox, configuredMailboxes, type MailboxId } from "./mailboxes";
import { sendEmail } from "./mailer";
import { getObjectBuffer } from "./storage";
import { isWithinSchedule } from "./whatsapp-autoreply";
import { addCustomTag } from "./tags-service";
import { extractCidImageIds, buildInlineImageAttachments, sanitizeEmailHtml } from "./mail-html";
import { htmlToPlainText, looksLikeHtml } from "./message-templates";

export type TermMatch = "any" | "all";

export interface EmailAutoReplyMatchable {
  subjectTerms: string[];
  bodyTerms: string[];
  termMatch: string;
  enabled: boolean;
}

/** Case-insensitive substring, so a URL or a whole phrase works unchanged. */
function hit(haystack: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  return t.length > 0 && haystack.includes(t);
}

/**
 * Does one field's term list match?
 *
 * An EMPTY list matches — it means "no condition on this field", which is
 * what makes a subject-only or body-only rule work. That is why the caller
 * has to check separately whether a rule has any terms at all: without it,
 * every empty rule would match everything.
 */
function fieldMatches(haystack: string, terms: string[], mode: TermMatch): boolean {
  const real = terms.map((t) => t.trim()).filter(Boolean);
  if (!real.length) return true;
  return mode === "all"
    ? real.every((t) => hit(haystack, t))
    : real.some((t) => hit(haystack, t));
}

export function hasTerms(rule: { subjectTerms: string[]; bodyTerms: string[] }): boolean {
  return [...rule.subjectTerms, ...rule.bodyTerms].some((t) => t.trim().length > 0);
}

/**
 * Do a rule's subject and body terms both hold for this email? Takes the
 * haystacks already lower-cased. Says nothing about a rule with no terms —
 * it returns true for one, so callers decide what an empty rule means (a
 * catch-all reply, or no tag at all).
 */
export function emailTermsMatch(
  rule: { subjectTerms: string[]; bodyTerms: string[]; termMatch: string },
  subject: string,
  body: string,
): boolean {
  const mode: TermMatch = rule.termMatch === "all" ? "all" : "any";
  return fieldMatches(subject, rule.subjectTerms, mode) && fieldMatches(body, rule.bodyTerms, mode);
}

/**
 * Pick the rule an inbound email triggers.
 *
 * Deliberately NOT whatsapp-autoreply's matchAutoReply: that one matches a
 * single substring against a body, and email has a subject as well as
 * several terms per field.
 *
 * The shape of a match:
 *   • within a field, terms combine per the rule's own any/all setting;
 *   • the two fields AND together, so "subject says enquiry AND the body
 *     carries this link" is expressible — a field left empty is simply no
 *     condition rather than a condition that fails;
 *   • rules with terms are tried in creation order, first match wins;
 *   • a rule with no terms at all is the catch-all, used only when nothing
 *     specific matched. Same precedence as the WhatsApp version, so the two
 *     behave alike where they are configured alike.
 *
 * Pure, so the matching rules are testable without a database.
 */
export function matchEmailAutoReply<T extends EmailAutoReplyMatchable>(
  rules: T[],
  input: { subject: string; body: string },
): T | null {
  const subject = (input.subject ?? "").toLowerCase();
  const body = (input.body ?? "").toLowerCase();
  const enabled = rules.filter((r) => r.enabled);

  const specific = enabled.filter(hasTerms);
  const catchAll = enabled.filter((r) => !hasTerms(r));

  const found = specific.find((r) => emailTermsMatch(r, subject, body));
  return found ?? catchAll[0] ?? null;
}

export interface EmailAutoReplyDTO {
  id: string;
  mailboxId: string;
  subjectTerms: string[];
  bodyTerms: string[];
  termMatch: TermMatch;
  subject: string | null;
  replyText: string;
  attachmentDocumentIds: string[];
  attachments: { id: string; filename: string; mimeType: string; sizeBytes: number }[];
  /** Tag put on the lead when the rule matches, if any. */
  tagOnMatch: string | null;
  enabled: boolean;
  activeFromMin: number | null;
  activeToMin: number | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  mailboxId: string;
  subjectTerms: string[];
  bodyTerms: string[];
  termMatch: string;
  subject: string | null;
  replyText: string;
  attachmentDocumentIds: string[];
  tagOnMatch: string | null;
  enabled: boolean;
  activeFromMin: number | null;
  activeToMin: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Attachments are a String[] of document ids rather than a relation, so they
 * are hydrated by a second query. Done for every read so the settings UI can
 * name each file, and an id whose document has since been deleted simply
 * drops out rather than showing a blank row.
 */
async function hydrate(rows: Row[]): Promise<EmailAutoReplyDTO[]> {
  const ids = [...new Set(rows.flatMap((r) => r.attachmentDocumentIds))];
  const docs = ids.length
    ? await prisma.document.findMany({
        where: { id: { in: ids } },
        select: { id: true, filename: true, mimeType: true, sizeBytes: true },
      })
    : [];
  const byId = new Map(docs.map((d) => [d.id, d]));
  return rows.map((r) => ({
    id: r.id,
    mailboxId: r.mailboxId,
    subjectTerms: r.subjectTerms,
    bodyTerms: r.bodyTerms,
    termMatch: r.termMatch === "all" ? "all" : "any",
    subject: r.subject,
    replyText: r.replyText,
    attachmentDocumentIds: r.attachmentDocumentIds,
    attachments: r.attachmentDocumentIds.map((id) => byId.get(id)).filter((d): d is NonNullable<typeof d> => Boolean(d)),
    tagOnMatch: r.tagOnMatch,
    enabled: r.enabled,
    activeFromMin: r.activeFromMin,
    activeToMin: r.activeToMin,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Trimmed, blank-free, deduped — a stray empty line in the editor must not
 *  become a term that matches everything. */
function cleanTerms(terms: string[] | undefined): string[] {
  return [...new Set((terms ?? []).map((t) => t.trim()).filter(Boolean))];
}

export async function listEmailAutoReplies(mailboxId?: string): Promise<EmailAutoReplyDTO[]> {
  const rows = await prisma.emailAutoReply.findMany({
    where: mailboxId ? { mailboxId } : undefined,
    orderBy: [{ mailboxId: "asc" }, { createdAt: "asc" }],
  });
  return hydrate(rows);
}

export async function createEmailAutoReply(input: {
  mailboxId: string;
  subjectTerms?: string[];
  bodyTerms?: string[];
  termMatch?: TermMatch;
  subject?: string | null;
  replyText: string;
  attachmentDocumentIds?: string[];
  activeFromMin?: number | null;
  activeToMin?: number | null;
  tagOnMatch?: string | null;
  createdBy: string;
}): Promise<EmailAutoReplyDTO> {
  const row = await prisma.emailAutoReply.create({
    data: {
      mailboxId: input.mailboxId,
      subjectTerms: cleanTerms(input.subjectTerms),
      bodyTerms: cleanTerms(input.bodyTerms),
      termMatch: input.termMatch ?? "any",
      subject: input.subject?.trim() || null,
      replyText: input.replyText,
      attachmentDocumentIds: input.attachmentDocumentIds ?? [],
      tagOnMatch: input.tagOnMatch?.trim() || null,
      activeFromMin: input.activeFromMin ?? null,
      activeToMin: input.activeToMin ?? null,
      createdBy: input.createdBy,
    },
  });
  return (await hydrate([row]))[0];
}

export async function updateEmailAutoReply(
  id: string,
  input: {
    subjectTerms?: string[];
    bodyTerms?: string[];
    termMatch?: TermMatch;
    subject?: string | null;
    replyText?: string;
    attachmentDocumentIds?: string[];
    enabled?: boolean;
    activeFromMin?: number | null;
    activeToMin?: number | null;
    tagOnMatch?: string | null;
  },
): Promise<EmailAutoReplyDTO> {
  const row = await prisma.emailAutoReply.update({
    where: { id },
    data: {
      ...(input.subjectTerms !== undefined && { subjectTerms: cleanTerms(input.subjectTerms) }),
      ...(input.bodyTerms !== undefined && { bodyTerms: cleanTerms(input.bodyTerms) }),
      ...(input.termMatch !== undefined && { termMatch: input.termMatch }),
      ...(input.subject !== undefined && { subject: input.subject?.trim() || null }),
      ...(input.replyText !== undefined && { replyText: input.replyText }),
      ...(input.attachmentDocumentIds !== undefined && {
        attachmentDocumentIds: input.attachmentDocumentIds,
      }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.tagOnMatch !== undefined && { tagOnMatch: input.tagOnMatch?.trim() || null }),
      ...(input.activeFromMin !== undefined && { activeFromMin: input.activeFromMin }),
      ...(input.activeToMin !== undefined && { activeToMin: input.activeToMin }),
    },
  });
  return (await hydrate([row]))[0];
}

export async function deleteEmailAutoReply(id: string): Promise<void> {
  await prisma.emailAutoReply.delete({ where: { id } });
}

// ---------------------------------------------------------------------------
// Loop safety
// ---------------------------------------------------------------------------

/**
 * Local-parts that never belong to a person. Matched on the local-part alone
 * so it holds for any domain — bounces come from mailer-daemon@ at whatever
 * host relayed them, not at ours.
 */
const ROBOT_LOCAL_PARTS = [
  "mailer-daemon",
  "postmaster",
  "no-reply",
  "noreply",
  "donotreply",
  "do-not-reply",
  "bounce",
  "bounces",
];

/** Headers that say "a machine sent this" (RFC 3834 and the de-facto ones). */
export function looksAutoGenerated(headers: Map<string, unknown>): boolean {
  const get = (k: string) => {
    const v = headers.get(k);
    return typeof v === "string" ? v.toLowerCase() : "";
  };
  const autoSubmitted = get("auto-submitted");
  // "auto-submitted: no" is the explicit marker for a human-sent message.
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (["bulk", "list", "junk", "auto_reply"].includes(get("precedence"))) return true;
  if (headers.has("list-id") || headers.has("list-unsubscribe")) return true;
  if (get("x-auto-response-suppress")) return true;
  if (get("x-autoreply") || get("x-autorespond")) return true;
  return false;
}

export function isRobotAddress(email: string | null | undefined): boolean {
  if (!email) return true;
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return ROBOT_LOCAL_PARTS.some((r) => local === r || local.startsWith(`${r}+`) || local.endsWith(`-${r}`));
}

/** Every address this CRM sends as — replying to one of these is the loop. */
export function ourOwnAddresses(): Set<string> {
  const out = new Set<string>();
  for (const m of configuredMailboxes()) {
    if (m.address) out.add(m.address.toLowerCase());
    if (m.imap.user) out.add(m.imap.user.toLowerCase());
  }
  return out;
}

/** The domains those addresses live on. */
export function ourOwnDomains(addresses: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const a of addresses) {
    const d = a.split("@")[1];
    if (d) out.add(d.toLowerCase());
  }
  return out;
}

/** Don't answer the same address twice inside this window. */
export const COOLDOWN_HOURS = 6;

export interface AutoReplyDecision {
  send: boolean;
  reason: string;
}

/**
 * Pure part of the decision — everything except "have we replied recently",
 * which needs the database. Split out so the guards are unit-testable, since
 * they are the whole reason this feature is safe to run.
 */
export function shouldAutoReply(input: {
  fromEmail: string | null;
  headers: Map<string, unknown>;
  ourAddresses: Set<string>;
}): AutoReplyDecision {
  const from = input.fromEmail?.toLowerCase() ?? null;
  if (!from) return { send: false, reason: "no sender address" };
  // The one that matters most here: the website form mailer posts as our own
  // address, so this is the common case, not the edge case.
  if (input.ourAddresses.has(from)) return { send: false, reason: "sender is one of our own mailboxes" };
  // Anything else on our own domain is an internal system sender, not a guest
  // — wp@ (the WordPress form mailer, 86 of this CRM's inbound emails) and
  // ma@ are both real examples. Replying to them is at best noise and at
  // worst a loop with whatever sits behind them. Staff writing from a company
  // address are staff, and do not need an auto-reply either.
  const domain = from.split("@")[1] ?? "";
  if (ourOwnDomains(input.ourAddresses).has(domain)) {
    return { send: false, reason: "sender is on our own domain" };
  }
  if (isRobotAddress(from)) return { send: false, reason: "sender is a no-reply/daemon address" };
  if (looksAutoGenerated(input.headers)) return { send: false, reason: "message is machine-generated" };
  return { send: true, reason: "ok" };
}

/**
 * What an inbound email earns once a recipient decision has been made and a
 * rule has (or has not) matched.
 *
 * Tagging and replying are separate on purpose. A tag records what the lead
 * asked for — "requested the Clinical Programs itinerary" — and that stays
 * true when no reply can go out: a form submitted with no email address, or
 * a welcome email that already went to them this second. So:
 *   • junk (a bounce, a no-reply, a machine) is not even considered;
 *   • a matched rule tags the lead whenever it is considered;
 *   • a reply additionally needs someone to send it to and no welcome email
 *     having just gone out.
 */
export function autoReplyOutcome(input: {
  decision: { send: boolean; relay: boolean; to: string | null };
  matched: boolean;
  welcomeSent: boolean;
}): { considered: boolean; tag: boolean; send: boolean } {
  const considered = input.decision.send || input.decision.relay;
  const tag = considered && input.matched;
  const send = tag && input.decision.send && Boolean(input.decision.to) && !input.welcomeSent;
  return { considered, tag, send };
}

/**
 * Who, if anyone, an inbound message should be answered AT.
 *
 * Most mail is answered at its sender, under shouldAutoReply's guards. The
 * exception is a FORM RELAY: the website's form mailer posts every submission
 * as our own address — all 82 "Viewing Sample Itinerary" requests came from
 * hello@ — so the sender is us, and the person who actually asked is the
 * guest the form resolved to. Before this, every such email was refused as
 * "sender is one of our own mailboxes", which is precisely the case a trigger
 * on a form exists to serve.
 *
 * The loop protection moves rather than weakens. For a relay it is the
 * RECIPIENT, the guest's own address, that gets checked: never one of ours,
 * never our domain, never a no-reply address. The relay's headers are not
 * checked, because they describe the form mailer rather than the guest, and
 * the form mailer is not who is being answered.
 *
 * A direct sender cannot use this to redirect a reply: the guest address is
 * only consulted when the sender is us.
 */
export function resolveAutoReplyRecipient(input: {
  fromEmail: string | null;
  guestEmail: string | null;
  headers: Map<string, unknown>;
  ourAddresses: Set<string>;
}): AutoReplyDecision & { to: string | null; relay: boolean } {
  const from = input.fromEmail?.trim().toLowerCase() || null;
  const ourDomains = ourOwnDomains(input.ourAddresses);
  const isOurs = (a: string) => input.ourAddresses.has(a) || ourDomains.has(a.split("@")[1] ?? "");

  if (from && isOurs(from)) {
    const guest = input.guestEmail?.trim().toLowerCase() || null;
    if (!guest) return { send: false, reason: "form relay with no guest email", to: null, relay: true };
    if (isOurs(guest)) return { send: false, reason: "form relay resolved to our own address", to: null, relay: true };
    if (isRobotAddress(guest)) return { send: false, reason: "form relay resolved to a no-reply address", to: null, relay: true };
    return { send: true, reason: "ok (form relay)", to: guest, relay: true };
  }

  const direct = shouldAutoReply(input);
  return { ...direct, to: direct.send ? from : null, relay: false };
}

/**
 * Every configured mailbox that reads the same IMAP account as `id`.
 *
 * Here both do — sales and doctor both poll hello@ — and whichever poller
 * stores a message first stamps it with its own id: 6 of the 82 itinerary
 * requests were stored as "doctor". Looking rules up across the whole inbox
 * means which poller won that race can't decide whether a guest is answered.
 */
export function mailboxesSharingInbox(id: string): string[] {
  const all = configuredMailboxes();
  const inbox = all.find((m) => m.id === id)?.imap.user?.toLowerCase();
  if (!inbox) return [id];
  return all.filter((m) => m.imap.user?.toLowerCase() === inbox).map((m) => m.id);
}

/**
 * The email a rule produces, ready to send. Shared by the live path and the
 * test script, so a test email is the real email rather than a lookalike.
 */
export async function renderEmailAutoReply(
  rule: { subject: string | null; replyText: string; attachmentDocumentIds: string[] },
  incomingSubject: string,
) {
  const attachments = await loadRuleAttachments(rule.attachmentDocumentIds);
  const incoming = incomingSubject.trim();
  const subject =
    rule.subject?.trim() ||
    (incoming.toLowerCase().startsWith("re:") ? incoming : `Re: ${incoming || "your message"}`);
  // The reply is authored in the rich editor, so it is HTML — but a rule
  // written before that editor (or pasted as plain text) is not, and sending
  // markup-free text as an HTML part would collapse its newlines.
  const isHtml = looksLikeHtml(rule.replyText);
  const html = isHtml ? sanitizeEmailHtml(rule.replyText) : undefined;
  const text = isHtml ? htmlToPlainText(rule.replyText) : rule.replyText;
  // Inline images travel with the message; there is no public host to link
  // them from. Same resolution the compose box uses.
  const inlineImages = html ? await buildInlineImageAttachments(extractCidImageIds(html)) : [];
  return { subject, text, html, attachments: [...attachments, ...inlineImages] };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Called from the inbound email poller once a message has been stored.
 *
 * Best-effort in the same sense as the WhatsApp version: it never throws, so
 * a failure here cannot stop an inbound email being ingested. The difference
 * is that it also never *sends* unless every guard above passes.
 */
export async function maybeSendEmailAutoReply(input: {
  mailboxId: MailboxId;
  parsed: ParsedMail;
  fromEmail: string | null;
  body: string;
  guestId: string;
  enquiryId?: string | null;
  inReplyToMessageId: string | null;
  /** A welcome email just went to this guest: tag, but don't also reply. */
  welcomeSent?: boolean;
}): Promise<void> {
  try {
    const guest = await prisma.guest.findUnique({
      where: { id: input.guestId },
      select: { email: true },
    });
    const decision = resolveAutoReplyRecipient({
      fromEmail: input.fromEmail,
      guestEmail: guest?.email ?? null,
      headers: input.parsed.headers as unknown as Map<string, unknown>,
      ourAddresses: ourOwnAddresses(),
    });
    if (!autoReplyOutcome({ decision, matched: true, welcomeSent: false }).considered) {
      logger.debug({ mailbox: input.mailboxId, reason: decision.reason }, "email auto-reply: skipped");
      return;
    }

    const rules = await prisma.emailAutoReply.findMany({
      where: { mailboxId: { in: mailboxesSharingInbox(input.mailboxId) }, enabled: true },
      orderBy: { createdAt: "asc" },
    });
    if (!rules.length) return;

    // Subject AND body, several terms per field — see matchEmailAutoReply.
    const scheduled = rules.filter((r) => isWithinSchedule(r.activeFromMin, r.activeToMin));
    const rule = matchEmailAutoReply(scheduled, {
      subject: input.parsed.subject ?? "",
      body: input.body,
    });
    if (!rule) return;

    const outcome = autoReplyOutcome({ decision, matched: true, welcomeSent: Boolean(input.welcomeSent) });

    // Tag before deciding whether to send — see autoReplyOutcome.
    if (outcome.tag && rule.tagOnMatch && input.enquiryId) {
      await addCustomTag(input.enquiryId, rule.tagOnMatch, "email-autoreply").catch((err) =>
        logger.error({ err, enquiryId: input.enquiryId, ruleId: rule.id }, "email auto-reply: tagging failed"),
      );
    }

    if (!outcome.send || !decision.to) {
      logger.info(
        { mailbox: input.mailboxId, ruleId: rule.id, reason: input.welcomeSent ? "welcome email just sent" : decision.reason },
        "email auto-reply: matched but not sent",
      );
      return;
    }
    const to = decision.to;

    // Last guard, and the one that holds even if the others are wrong about
    // a particular correspondent.
    const recent = await prisma.message.findFirst({
      where: {
        direction: "outbound",
        channel: "email",
        toEmail: to,
        autoReplyRuleId: { not: null },
        createdAt: { gt: new Date(Date.now() - COOLDOWN_HOURS * 3600_000) },
      },
      select: { id: true },
    });
    if (recent) {
      logger.info({ to, hours: COOLDOWN_HOURS }, "email auto-reply: already replied recently, skipping");
      return;
    }

    // Sent as the mailbox the rule belongs to, not whichever poller happened
    // to store the inbound copy.
    const mailbox = getMailbox(rule.mailboxId as MailboxId) ?? getMailbox(input.mailboxId);
    if (!mailbox?.configured) return;

    const reply = await renderEmailAutoReply(rule, input.parsed.subject ?? "");

    // A direct reply threads onto the message it answers. A relay does not:
    // the guest never received the form mailer's email, so threading onto it
    // would point their mail client at a message that isn't in their inbox.
    const threadOn = decision.relay ? null : input.inReplyToMessageId;

    const res = await sendEmail(mailbox, {
      to,
      subject: reply.subject,
      text: reply.text,
      html: reply.html,
      inReplyTo: threadOn ?? undefined,
      references: threadOn ? [threadOn] : undefined,
      attachments: reply.attachments,
      // RFC 3834. This is what stops the correspondent's own responder
      // answering ours and starting the loop from the other end.
      headers: {
        "Auto-Submitted": "auto-replied",
        "X-Auto-Response-Suppress": "All",
      },
    });

    await prisma.message.create({
      data: {
        guestId: input.guestId,
        enquiryId: input.enquiryId ?? null,
        mailboxId: mailbox.id,
        channel: "email",
        direction: "outbound",
        subject: reply.subject,
        body: reply.text,
        bodyHtml: reply.html ?? null,
        fromEmail: mailbox.address,
        toEmail: to,
        messageId: res.messageId,
        inReplyTo: threadOn,
        references: threadOn ? [threadOn] : [],
        status: "sent",
        autoReplyRuleId: rule.id,
        // So the conversation shows a paperclip and names the files. Inline
        // images (cid parts) are part of the body, not attachments.
        attachmentNames: reply.attachments.filter((a) => !("cid" in a && a.cid)).map((a) => a.filename),
        // The first file, linked so it opens from the thread. Checked to still
        // exist — the email has already gone, and a dangling id here would
        // fail the insert and lose the record of it.
        attachmentDocumentId: rule.attachmentDocumentIds.length
          ? (await prisma.document.findFirst({
              where: { id: { in: rule.attachmentDocumentIds } },
              select: { id: true },
            }))?.id ?? null
          : null,
      },
    });

    logger.info({ to, ruleId: rule.id, mailbox: mailbox.id, relay: decision.relay }, "email auto-reply sent");
  } catch (err) {
    // Never let this break ingestion — the inbound message is already stored
    // and matters more than the courtesy reply.
    logger.error({ err, mailbox: input.mailboxId }, "email auto-reply failed");
  }
}

async function loadRuleAttachments(
  ids: string[],
): Promise<{ filename: string; content: Buffer; contentType?: string }[]> {
  if (!ids.length) return [];
  const docs = await prisma.document.findMany({
    where: { id: { in: ids } },
    select: { id: true, filename: true, mimeType: true, storageKey: true },
  });
  const out: { filename: string; content: Buffer; contentType?: string }[] = [];
  for (const doc of docs) {
    try {
      out.push({
        filename: doc.filename,
        content: await getObjectBuffer(doc.storageKey),
        contentType: doc.mimeType,
      });
    } catch (err) {
      // Send the reply without it rather than not at all — the text is the
      // part the sender is waiting on.
      logger.warn({ err, documentId: doc.id }, "email auto-reply: attachment unreadable, skipping it");
    }
  }
  return out;
}
