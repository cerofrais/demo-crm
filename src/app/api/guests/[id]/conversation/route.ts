import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can, canReadAllGuestData } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toMessageDTO } from "@/lib/messages";
import {
  visibleMailboxIds,
  mailboxForRoles,
  canSendEmail,
  configuredMailboxes,
  type MailboxId,
} from "@/lib/mailboxes";

export const dynamic = "force-dynamic";

const PAGE = 20;

/**
 * GET /api/guests/:id/conversation?mailbox=<id|all>&cursor=<iso>
 * Per-mailbox-scoped email thread for a guest. Sales roles see the sales thread,
 * doctor sees the doctor thread, admin can see all (or filter). Cursor-paginated
 * newest-first so the UI isn't overloaded.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view") && !can(ctx.roles, "health.view")) {
      throw new ApiError("FORBIDDEN", "No access", 403);
    }

    const guest = await prisma.guest.findFirst({
      where: { id: params.id, deletedAt: null },
      select: { id: true, email: true },
    });
    if (!guest) throw new ApiError("NOT_FOUND", "Guest not found", 404);

    // F14: a mailbox thread exposes sender/subject/HTML bodies, so reading it is
    // ownership-scoped. ADMIN/MANAGER (leads.manage) see all; the doctor sees
    // their own clinical thread (health.view); everyone else (view-only STAFF,
    // own-only RECEPTION) must own an enquiry for this guest or they could read
    // arbitrary guests' correspondence (IDOR).
    if (!canReadAllGuestData(ctx.roles)) {
      const owns = await prisma.enquiry.findFirst({
        where: { guestId: guest.id, assignedToSub: ctx.sub },
        select: { id: true },
      });
      if (!owns) {
        throw new ApiError("FORBIDDEN", "You can only view conversations for your own guests", 403);
      }
    }

    const visible = visibleMailboxIds(ctx.roles);
    const sp = req.nextUrl.searchParams;
    const requested = sp.get("mailbox") as MailboxId | "all" | null;

    let scope: MailboxId[];
    if (requested === "all") scope = visible;
    else if (requested && visible.includes(requested)) scope = [requested];
    else scope = [visible[0]].filter(Boolean) as MailboxId[];

    const cursor = sp.get("cursor");
    const rows = await prisma.message.findMany({
      where: {
        guestId: guest.id,
        mailboxId: { in: scope },
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      include: { attachmentDocument: true },
      orderBy: { createdAt: "desc" },
      take: PAGE + 1,
    });

    const hasMore = rows.length > PAGE;
    const items = rows.slice(0, PAGE).map((m) => toMessageDTO(m));
    const nextCursor = hasMore ? rows[PAGE - 1].createdAt.toISOString() : null;

    const myMailbox = mailboxForRoles(ctx.roles);
    return ok({
      items, // newest-first
      nextCursor,
      activeMailbox: scope.length === 1 ? scope[0] : "all",
      guestEmail: guest.email,
      fromAddress: myMailbox?.from ?? null,
      canSend:
        canSendEmail(ctx.roles) && Boolean(myMailbox?.configured) && Boolean(guest.email),
      // admins get a mailbox switcher
      mailboxOptions: ctx.roles.includes("ADMIN")
        ? configuredMailboxes().map((m) => ({ id: m.id, label: m.label }))
        : [],
    });
  });
}
