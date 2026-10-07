/**
 * Which WhatsApp lines a staff member may send from.
 *
 * An admin can pin a person to specific lines on the Users page
 * (StaffProfile.allowedWhatsAppNumbers). This is the one place that rule is
 * read, so the 1:1 composer, bulk broadcast and every number picker agree on
 * it — a list duplicated across call sites in this codebase has drifted more
 * than once.
 *
 * Numbers are compared as E.164, never by WhatsAppNumber.id: a re-paired line
 * gets a fresh row, and an id comparison would treat the same phone as a
 * different line.
 *
 * Only SENDING is restricted. Reading a guest's thread is not: it is one
 * shared conversation per guest across every line, and hiding the messages
 * another line exchanged would leave the person replying without context.
 */
import { prisma } from "./prisma";
import { normalizeOurNumber } from "./lead-assignment";

/** null means unrestricted — the person may use every line they are otherwise offered. */
export type AllowedNumbers = Set<string> | null;

export async function allowedWhatsAppNumbersFor(sub: string): Promise<AllowedNumbers> {
  const profile = await prisma.staffProfile.findUnique({
    where: { keycloakId: sub },
    select: { allowedWhatsAppNumbers: true },
  });
  return toAllowedSet(profile?.allowedWhatsAppNumbers);
}

/** Pure half of the above, exported for testing. */
export function toAllowedSet(list: string[] | null | undefined): AllowedNumbers {
  const normalized = (list ?? []).map((n) => normalizeOurNumber(n)).filter((n): n is string => Boolean(n));
  return normalized.length ? new Set(normalized) : null;
}

/**
 * May a person with `allowed` send from a line whose phone is `phoneNumber`?
 *
 * A line with no phone yet — paired but not reported, or still awaiting its
 * QR scan — is refused to a restricted person: there is nothing to match it
 * against, and letting it through would make "pending" a way around the rule.
 */
export function isNumberAllowed(allowed: AllowedNumbers, phoneNumber: string | null | undefined): boolean {
  if (allowed === null) return true;
  const key = normalizeOurNumber(phoneNumber);
  return key !== null && allowed.has(key);
}
