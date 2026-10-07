import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can, canUseWhatsAppIntegration } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toMessageDTO, resolveReplyTargets } from "@/lib/messages";
import { getLineIndex } from "@/lib/whatsapp-lines";
import { resolveMyWhatsAppNumberId } from "@/lib/whatsapp";
import { allowedWhatsAppNumbersFor, isNumberAllowed } from "@/lib/whatsapp-number-access";

export const dynamic = "force-dynamic";

const PAGE = 20;

/**
 * GET /api/guests/:id/whatsapp?cursor=<iso>
 * One unified WhatsApp thread per guest — unlike email there's no per-role
 * mailbox split, all connected numbers share one thread (see docs/17).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view")) {
      throw new ApiError("FORBIDDEN", "No access", 403);
    }

    const guest = await prisma.guest.findFirst({
      where: { id: params.id, deletedAt: null },
      select: { id: true, phone: true },
    });
    if (!guest) throw new ApiError("NOT_FOUND", "Guest not found", 404);

    const cursor = req.nextUrl.searchParams.get("cursor");
    const rows = await prisma.message.findMany({
      where: {
        guestId: guest.id,
        channel: "whatsapp",
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      include: { attachmentDocument: true },
      orderBy: { createdAt: "desc" },
      take: PAGE + 1,
    });

    // mailboxId stores the sending number's instanceName — resolve to its
    // label (e.g. "Sales Line") so the thread can show which number an
    // outbound message went out from instead of a generic "You". Looked up
    // across all numbers (not just connected ones) so old messages from a
    // since-disconnected number still resolve.
    const allNumbers = await prisma.whatsAppNumber.findMany({
      select: { id: true, label: true, phoneNumber: true, isDefault: true, shared: true, instanceName: true, status: true, integration: true },
    });
    const labelByInstance = new Map(allNumbers.map((n) => [n.instanceName, n.label]));
    const integrationByInstance = new Map(allNumbers.map((n) => [n.instanceName, n.integration]));

    const hasMore = rows.length > PAGE;
    const page = rows.slice(0, PAGE);
    const replyTargets = await resolveReplyTargets(page);
    // Inbound messages from before our number was recorded on them (July)
    // get it back from their pairing, so the thread colors every message on
    // one line the same — see numberColor in whatsapp-panel.tsx.
    const { numberByInstance, options: lineOptions } = await getLineIndex();
    const items = page.map((m) => {
      const dto = toMessageDTO(
        m,
        m.direction === "outbound" ? labelByInstance.get(m.mailboxId) ?? null : null,
        integrationByInstance.get(m.mailboxId) ?? null,
        m.inReplyTo ? replyTargets.get(m.inReplyTo) ?? null : null,
      );
      if (m.direction === "inbound" && !dto.toEmail) {
        dto.toEmail = numberByInstance.get(m.mailboxId) ?? null;
      }
      return dto;
    });
    const nextCursor = hasMore ? rows[PAGE - 1].createdAt.toISOString() : null;

    // Not shared: taken out of the staff-facing pool by an admin, but its
    // past messages above still resolve correctly via labelByInstance
    // (built from allNumbers, unfiltered) — this filter is scoped to what's
    // offered as a *selectable* option going forward.
    // Cloud API numbers ARE selectable for 1:1 replies too (see
    // docs/17-whatsapp-integration.md) — free text only actually delivers
    // inside Meta's 24h customer-service window (opened by the guest's last
    // inbound message), same constraint Meta enforces on any Cloud API
    // number; outside that window the send just comes back failed, same as
    // any other delivery failure.
    // Lines an admin has pinned this person to, if any (Users page). Applied
    // to the options before anything below derives from them, so the
    // suggested, established and "mine" defaults can never point at a line
    // the send route would refuse.
    const allowed = await allowedWhatsAppNumbersFor(ctx.sub);
    const numbers = allNumbers
      .filter((n) => n.status === "connected" && n.shared)
      .filter((n) => isNumberAllowed(allowed, n.phoneNumber))
      // The official Cloud API number is senior-staff only — see
      // canUseWhatsAppIntegration. Filtered out of the picker entirely rather
      // than shown-and-refused, so a rep never composes into a dead end.
      .filter((n) => canUseWhatsAppIntegration(ctx.roles, n.integration))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label))
      // `integration` rides along because the composer behaves differently on
      // a Cloud API line: Meta only accepts an approved template there once a
      // guest has been quiet for 24 hours, so the template button offers
      // Meta's templates rather than the CRM's.
      .map(({ id, label, phoneNumber, isDefault, instanceName, integration }) => ({
        id,
        label,
        phoneNumber,
        isDefault,
        instanceName,
        integration,
      }));

    // A reply should default to whichever number this conversation is
    // actually on, not just whichever number is marked "default" org-wide —
    // otherwise a guest who messaged in on a specific number gets replied to
    // from a different one. Looked up independent of the cursor/pagination
    // above so it's always the true latest message, not just the latest of
    // whichever page was requested.
    const lastMessage = await prisma.message.findFirst({
      where: { guestId: guest.id, channel: "whatsapp" },
      orderBy: { createdAt: "desc" },
      select: { mailboxId: true, direction: true, fromEmail: true, toEmail: true },
    });
    const idByInstance = new Map(allNumbers.map((n) => [n.instanceName, n.id]));

    // Re-pairing a number mints a NEW instance name, so history written under
    // the old one stops matching by instanceName — on this deployment the same
    // phone has been paired three times in eight days, leaving real
    // conversations looking like they belong to no number at all. The phone
    // itself doesn't change, and every message records it (our side is
    // `fromEmail` when we sent, `toEmail` when they did), so fall back to that.
    const ourPhone = lastMessage
      ? lastMessage.direction === "outbound"
        ? lastMessage.fromEmail
        : lastMessage.toEmail
      : null;
    const idByPhone = new Map(
      allNumbers.flatMap((n) => (n.phoneNumber ? [[n.phoneNumber, n.id] as const] : [])),
    );
    const lastNumberId = lastMessage
      ? (idByInstance.get(lastMessage.mailboxId) ??
         (ourPhone ? idByPhone.get(ourPhone) ?? null : null))
      : null;
    // Only suggest it if that number is still connected — can't send from one that isn't.
    const suggestedNumberId = numbers.some((n) => n.id === lastNumberId) ? lastNumberId : null;

    // The number this conversation actually lives on, reported whether or not
    // it's still connected — which is exactly the case suggestedNumberId
    // can't cover. The composer warns before sending from anything else: to
    // the guest, a reply from an unfamiliar number reads as a stranger (or a
    // scam), and it's the pattern WhatsApp itself treats as ban evasion when
    // a business starts working the same contacts from a second line.
    const establishedNumber = lastNumberId
      ? (() => {
          const n = allNumbers.find((x) => x.id === lastNumberId);
          return n
            ? {
                id: n.id,
                label: n.label,
                // Carried so the composer can compare on the number the GUEST
                // sees. Re-pairing mints a fresh row for the same phone, and
                // an id comparison would call that a different number and warn
                // about a switch that never happened.
                phoneNumber: n.phoneNumber,
                selectable: numbers.some((s) => s.id === n.id),
                // The composer locks a conversation that lives on the official
                // Cloud API line to that line — see whatsapp-panel.
                integration: n.integration,
              }
            : null;
        })()
      : null;

    // Below the conversation's own sticky number (guest continuity comes
    // first) but above the org-wide default — a rep whose own phone is a
    // connected number shouldn't see someone else's line preselected on a
    // guest they haven't messaged before.
    const myNumberId = await resolveMyWhatsAppNumberId(ctx.sub);

    return ok({
      items, // newest-first
      nextCursor,
      guestPhone: guest.phone,
      canSend: can(ctx.roles, "messaging.send") && Boolean(guest.phone) && numbers.length > 0,
      numberOptions: numbers,
      // Each line's color slot, org-wide: every number that has ever sent,
      // in a fixed order, so a line is the same color in every thread and no
      // two lines share one. See numberColor in whatsapp-panel.tsx.
      lineColorSlots: Object.fromEntries(lineOptions.map((o, i) => [o.number, i])),
      suggestedNumberId,
      establishedNumber,
      myNumberId: numbers.some((n) => n.id === myNumberId) ? myNumberId : null,
      // Lets the composer explain an empty picker correctly: "you are not
      // assigned a connected line" is a different problem from "no line is
      // connected at all", and only an admin can fix the first.
      restrictedToNumbers: allowed !== null,
    });
  });
}
