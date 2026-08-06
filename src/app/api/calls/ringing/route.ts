/**
 * GET /api/calls/ringing — is there an inbound call ringing for ME right
 * now? Polled by the global IncomingCallBanner (see components/calls) so a
 * rep sees the caller's identity instead of just a bare Plivo number on
 * their phone. Self-scoped by repKeycloakId = the caller's own sub — no
 * permission gate beyond being signed in, since this can never expose
 * another rep's call.
 */
import { handle, ok, requireSession } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();

    const call = await prisma.call.findFirst({
      where: { repKeycloakId: ctx.sub, direction: "inbound", status: "ringing" },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        customerPhone: true,
        startedAt: true,
        guest: { select: { id: true, fullName: true, isReturning: true } },
      },
    });

    if (!call) return ok(null);

    return ok({
      callId: call.id,
      customerPhone: call.customerPhone,
      startedAt: call.startedAt.toISOString(),
      guestId: call.guest?.id ?? null,
      guestName: call.guest?.fullName ?? null,
      isReturning: call.guest?.isReturning ?? false,
    });
  });
}
