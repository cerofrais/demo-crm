import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toMessageDTO, resolveReplyTargets } from "@/lib/messages";
import { resolveMyWhatsAppNumberId } from "@/lib/whatsapp";

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

    const hasMore = rows.length > PAGE;
    const page = rows.slice(0, PAGE);
    const replyTargets = await resolveReplyTargets(page);
    const items = page.map((m) =>
      toMessageDTO(
        m,
        m.direction === "outbound" ? labelByInstance.get(m.mailboxId) ?? null : null,
        m.inReplyTo ? replyTargets.get(m.inReplyTo) ?? null : null,
      ),
    );
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
    const numbers = allNumbers
      .filter((n) => n.status === "connected" && n.shared)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label))
      .map(({ id, label, phoneNumber, isDefault, instanceName }) => ({ id, label, phoneNumber, isDefault, instanceName }));

    // A reply should default to whichever number this conversation is
    // actually on, not just whichever number is marked "default" org-wide —
    // otherwise a guest who messaged in on a specific number gets replied to
    // from a different one. Looked up independent of the cursor/pagination
    // above so it's always the true latest message, not just the latest of
    // whichever page was requested.
    const lastMessage = await prisma.message.findFirst({
      where: { guestId: guest.id, channel: "whatsapp" },
      orderBy: { createdAt: "desc" },
      select: { mailboxId: true },
    });
    const idByInstance = new Map(allNumbers.map((n) => [n.instanceName, n.id]));
    const lastNumberId = lastMessage ? (idByInstance.get(lastMessage.mailboxId) ?? null) : null;
    // Only suggest it if that number is still connected — can't send from one that isn't.
    const suggestedNumberId = numbers.some((n) => n.id === lastNumberId) ? lastNumberId : null;

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
      suggestedNumberId,
      myNumberId: numbers.some((n) => n.id === myNumberId) ? myNumberId : null,
    });
  });
}
