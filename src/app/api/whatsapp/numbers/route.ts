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
import { canUseWhatsAppIntegration } from "@/lib/rbac";
import { resolveMyWhatsAppNumberId } from "@/lib/whatsapp";
import { allowedWhatsAppNumbersFor, isNumberAllowed } from "@/lib/whatsapp-number-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const ctx = await requireAllPermissions(["messaging.send", "guests.view"]);
    const [all, myNumberId, allowed] = await Promise.all([
      prisma.whatsAppNumber.findMany({
        where: { status: "connected", shared: true },
        orderBy: [{ isDefault: "desc" }, { label: "asc" }],
        select: { id: true, label: true, phoneNumber: true, isDefault: true, integration: true },
      }),
      resolveMyWhatsAppNumberId(ctx.sub),
      allowedWhatsAppNumbersFor(ctx.sub),
    ]);
    // The official Cloud API number is senior-staff only — see
    // canUseWhatsAppIntegration. Filtered out for everyone else so it is
    // neither offered nor discoverable, which is also what the guests.view
    // gate above was reaching for less precisely.
    const numbers = all
      .filter((n) => canUseWhatsAppIntegration(ctx.roles, n.integration))
      // And only the lines an admin has pinned this person to, if any.
      .filter((n) => isNumberAllowed(allowed, n.phoneNumber));
    // A rep whose own phone is one of the connected numbers gets it flagged
    // — the picker defaults to it instead of some other line, so they don't
    // send from a number that isn't theirs without noticing.
    return ok(numbers.map((n) => ({ ...n, isMine: n.id === myNumberId })));
  });
}
