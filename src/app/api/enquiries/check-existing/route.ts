import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { stageLabel } from "@/lib/kanban";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const TERMINAL_STAGES = new Set(["converted", "lost"]);

/**
 * GET /api/enquiries/check-existing?phone=...&email=...
 *
 * Pre-submit duplicate check for the New Lead dialog. Deliberately org-wide
 * — NOT scoped to the caller's own/unassigned leads like /api/enquiries is —
 * because the failure mode this exists to catch is exactly a rep creating a
 * second ticket for a guest who already has one OPEN under a *different*
 * rep, which their normal (ownership-scoped) leads view would never surface.
 * Returns just enough to warn and link through — not the full lead/guest
 * record — since this is reachable by anyone who can create a lead,
 * regardless of whether they'd normally be able to see this particular one.
 */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!(can(ctx.roles, "leads.manage") || can(ctx.roles, "leads.ownOnly"))) {
      throw new ApiError("FORBIDDEN", "Not allowed to create leads", 403);
    }
    const phone = req.nextUrl.searchParams.get("phone")?.trim() || undefined;
    const email = req.nextUrl.searchParams.get("email")?.trim() || undefined;
    if (!phone && !email) return ok({ found: false });

    const or: Prisma.GuestWhereInput[] = [];
    if (phone) or.push({ phone });
    if (email) or.push({ email });

    const guest = await prisma.guest.findFirst({
      where: { deletedAt: null, OR: or },
      select: {
        fullName: true,
        enquiries: {
          where: { deletedAt: null },
          orderBy: { lastActivityAt: "desc" },
          select: { id: true, stage: true, assignedToName: true },
        },
      },
    });
    const open = guest?.enquiries.find((e) => !TERMINAL_STAGES.has(e.stage));
    if (!guest || !open) return ok({ found: false });

    return ok({
      found: true,
      enquiryId: open.id,
      stage: stageLabel(open.stage),
      assignedToName: open.assignedToName,
      guestName: guest.fullName,
    });
  });
}
