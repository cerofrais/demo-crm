import { prisma } from "./prisma";
import { logger } from "./logger";
import { addCustomTag } from "./tags-service";
import { slugifyTag } from "./lead-tags";
import { emailTermsMatch, hasTerms, type TermMatch } from "./email-autoreply";

/**
 * Auto-tagging for inbound EMAIL — the sibling of auto-tag.ts (WhatsApp).
 *
 * Terms are matched exactly like an email auto-reply (subject list and body
 * list, any/all within a list, the two lists AND together), so a rep who has
 * written one kind of rule can write the other. Two deliberate differences
 * from an auto-reply:
 *   • EVERY matching rule applies — tags aren't exclusive, one email can be
 *     both price-asked and double-occupancy;
 *   • a rule with no terms matches nothing. A catch-all reply makes sense; a
 *     catch-all tag would just be a tag on every lead.
 */

export interface EmailAutoTagDTO {
  id: string;
  mailboxId: string;
  subjectTerms: string[];
  bodyTerms: string[];
  termMatch: TermMatch;
  tag: string;
  enabled: boolean;
  createdAt: string;
}

function toDTO(row: {
  id: string; mailboxId: string; subjectTerms: string[]; bodyTerms: string[];
  termMatch: string; tag: string; enabled: boolean; createdAt: Date;
}): EmailAutoTagDTO {
  return {
    id: row.id,
    mailboxId: row.mailboxId,
    subjectTerms: row.subjectTerms,
    bodyTerms: row.bodyTerms,
    termMatch: row.termMatch === "all" ? "all" : "any",
    tag: row.tag,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The guest's own words: the body with any quoted earlier email cut off.
 *
 * A reply quotes what it answers, and what it answers is usually OUR email —
 * a brochure mail that says "Experience Packages" and "pricing". Matching the
 * quote would tag the guest with whatever we wrote to them. Cuts at the
 * first quote header (Gmail's "On … wrote:", which Gmail wraps over two
 * lines when the sender is long; Outlook's "From:/Sent:" block; the
 * "Original Message" rule) and drops any remaining "> " lines. A forwarded
 * message is kept: when staff forward a guest's email in, that IS the
 * guest's text. That matters for the From:/Date: rule in particular — Gmail
 * puts exactly that header under "Forwarded message", and production has
 * website forms forwarded in from gm@ that it would otherwise have erased.
 */
export function stripQuotedReply(text: string): string {
  let cut = text.length;
  const earliest = (re: RegExp, skip?: (index: number) => boolean) => {
    for (const m of text.matchAll(re)) {
      if (m.index === undefined || m.index >= cut) break;
      if (skip?.(m.index)) continue;
      cut = m.index;
      break;
    }
  };
  earliest(/^On\b[^\n]*(?:\n[^\n]*)?\bwrote:[ \t]*$/gm);
  earliest(/^-{2,}\s*Original Message\s*-{2,}/gim);
  earliest(/^From:[^\n]*\n(?:[^\n]*\n)?(?:Sent|Date):/gm, (index) => {
    const before = text.slice(0, index).trimEnd().split("\n").pop() ?? "";
    return /forwarded message/i.test(before);
  });
  return text
    .slice(0, cut)
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

/**
 * Every tag an inbound email earns. Pure (no I/O) so the rules are testable
 * without a database. Distinct tags, in rule order.
 */
export function matchEmailAutoTags<
  T extends { subjectTerms: string[]; bodyTerms: string[]; termMatch: string; tag: string; enabled: boolean },
>(rules: T[], input: { subject: string; body: string }): string[] {
  const subject = (input.subject ?? "").toLowerCase();
  const body = stripQuotedReply(input.body ?? "").toLowerCase();
  const tags = rules
    .filter((r) => r.enabled && r.tag.trim() && hasTerms(r))
    .filter((r) => emailTermsMatch(r, subject, body))
    .map((r) => r.tag);
  return Array.from(new Set(tags));
}

/** Trimmed, blank-free, deduped — a stray empty line must not become a term. */
function cleanTerms(terms: string[] | undefined): string[] {
  return [...new Set((terms ?? []).map((t) => t.trim()).filter(Boolean))];
}

export async function listEmailAutoTags(mailboxId?: string): Promise<EmailAutoTagDTO[]> {
  const rows = await prisma.emailAutoTag.findMany({
    where: mailboxId ? { mailboxId } : undefined,
    orderBy: [{ mailboxId: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toDTO);
}

export async function createEmailAutoTag(input: {
  mailboxId: string;
  subjectTerms?: string[];
  bodyTerms?: string[];
  termMatch?: TermMatch;
  tag: string;
  createdBy: string;
}): Promise<EmailAutoTagDTO> {
  const row = await prisma.emailAutoTag.create({
    data: {
      mailboxId: input.mailboxId,
      subjectTerms: cleanTerms(input.subjectTerms),
      bodyTerms: cleanTerms(input.bodyTerms),
      termMatch: input.termMatch ?? "any",
      tag: slugifyTag(input.tag),
      createdBy: input.createdBy,
    },
  });
  return toDTO(row);
}

export async function updateEmailAutoTag(
  id: string,
  input: { subjectTerms?: string[]; bodyTerms?: string[]; termMatch?: TermMatch; tag?: string; enabled?: boolean },
): Promise<EmailAutoTagDTO> {
  const row = await prisma.emailAutoTag.update({
    where: { id },
    data: {
      ...(input.subjectTerms !== undefined && { subjectTerms: cleanTerms(input.subjectTerms) }),
      ...(input.bodyTerms !== undefined && { bodyTerms: cleanTerms(input.bodyTerms) }),
      ...(input.termMatch !== undefined && { termMatch: input.termMatch }),
      ...(input.tag !== undefined && { tag: slugifyTag(input.tag) }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    },
  });
  return toDTO(row);
}

export async function deleteEmailAutoTag(id: string): Promise<void> {
  await prisma.emailAutoTag.delete({ where: { id } });
}

/**
 * Called from inbound mail once the message is stored. Best-effort: any
 * failure is logged and swallowed, so tagging can never break mail intake.
 */
export async function applyEmailAutoTags(params: {
  mailboxId: string;
  guestId: string;
  enquiryId?: string | null;
  subject: string;
  body: string;
}): Promise<string[]> {
  const { mailboxId, guestId, enquiryId, subject, body } = params;
  try {
    if (!enquiryId || (!subject.trim() && !body.trim())) return [];

    const rules = await prisma.emailAutoTag.findMany({ where: { mailboxId, enabled: true } });
    const tags = matchEmailAutoTags(rules, { subject, body });
    if (!tags.length) return [];

    const enquiry = await prisma.enquiry.findUnique({
      where: { id: enquiryId },
      select: { tags: true },
    });
    // Adding is idempotent, the activity row isn't — a guest who keeps
    // writing about "price" shouldn't fill their timeline with it.
    const fresh = tags.filter((t) => !(enquiry?.tags ?? []).includes(t));
    if (!fresh.length) return [];

    for (const tag of fresh) {
      await addCustomTag(enquiryId, tag, "auto-tag");
    }
    await prisma.activity.create({
      data: {
        enquiryId,
        guestId,
        actorSub: "auto-tag",
        actorRole: "system",
        actorName: "Auto-tag",
        actionType: "auto_tagged",
        metadata: { tags: fresh, channel: "email", mailbox: mailboxId },
      },
    });
    logger.info({ guestId, enquiryId, tags: fresh }, "email auto-tag applied");
    return fresh;
  } catch (err) {
    logger.error({ err, guestId, enquiryId }, "email auto-tag failed");
    return [];
  }
}
