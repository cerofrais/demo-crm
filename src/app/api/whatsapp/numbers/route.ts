/**
 * GET /api/whatsapp/numbers — connected numbers for the Guests > WhatsApp
 * Broadcast send-from dropdown (its only consumer). Gated on both
 * messaging.send AND guests.view — messaging.send alone is too broad (Sales
 * holds it for per-lead chat but has no guests.view and shouldn't be able to
 * discover/target the broadcast-only Cloud API number via a direct call).
 * A number an admin has switched off "shared" is excluded entirely — it's
 * still connected and keeps working its existing conversations, it's just
 * not offered as a send-from option to staff anymore.
 */
import { handle, ok, requireAllPermissions } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { resolveMyWhatsAppNumberId } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const ctx = await requireAllPermissions(["messaging.send", "guests.view"]);
    const [numbers, myNumberId] = await Promise.all([
      prisma.whatsAppNumber.findMany({
        where: { status: "connected", shared: true },
        orderBy: [{ isDefault: "desc" }, { label: "asc" }],
        select: { id: true, label: true, phoneNumber: true, isDefault: true, integration: true },
      }),
      resolveMyWhatsAppNumberId(ctx.sub),
    ]);
    // A rep whose own phone is one of the connected numbers gets it flagged
    // — the picker defaults to it instead of some other line, so they don't
    // send from a number that isn't theirs without noticing.
    return ok(numbers.map((n) => ({ ...n, isMine: n.id === myNumberId })));
  });
}
