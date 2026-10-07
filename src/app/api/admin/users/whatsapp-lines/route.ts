/**
 * GET /api/admin/users/whatsapp-lines — the WhatsApp lines an admin can pin a
 * person to, for the Users page.
 *
 * Its own route rather than the WhatsApp admin list: that one is gated on
 * whatsapp.view, which someone managing users need not hold, and it returns
 * instance names and Meta ids this picker has no use for.
 */
import { handle, ok, requireAnyPermission } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    await requireAnyPermission(["users.manage", "users.view"]);
    const rows = await prisma.whatsAppNumber.findMany({
      where: { phoneNumber: { not: null } },
      select: { label: true, phoneNumber: true, status: true, integration: true },
      orderBy: { label: "asc" },
    });

    // Every re-pair leaves a row behind, so one phone can appear several
    // times. The restriction is keyed on the phone, so show each once —
    // preferring the row that is actually connected, whose label is current.
    const byPhone = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const prev = byPhone.get(r.phoneNumber!);
      if (!prev || (prev.status !== "connected" && r.status === "connected")) byPhone.set(r.phoneNumber!, r);
    }

    return ok(
      [...byPhone.values()].map((r) => ({
        phoneNumber: r.phoneNumber!,
        label: r.label,
        connected: r.status === "connected",
        integration: r.integration,
      })),
    );
  });
}
