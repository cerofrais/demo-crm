/**
 * GET /api/admin/whatsapp/numbers/:id/qr — current connection state, plus a
 * pairing QR code when `?pair=1` is set. The admin page polls this every few
 * seconds while the QR is on screen; once state flips to "open" we persist the
 * detected phone number and mark the row "connected".
 *
 * The QR is behind an explicit flag because asking for one makes WhatsApp
 * ISSUE one, and that is the thing it scores as automated behaviour. Without
 * the flag this route regenerated a code on every poll for any number that
 * wasn't open — so a number that had been logged out, or restricted, kept
 * minting codes for as long as anyone had the page up. State polling is free;
 * only deliberate pairing mints.
 */
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { getQrCode, getConnectionState, qrCooldownRemaining, resetQrAttempts, QrCooldownError } from "@/lib/whatsapp-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    await requirePermission("whatsapp.manage");
    const number = await prisma.whatsAppNumber.findUnique({ where: { id: params.id } });
    if (!number) throw new ApiError("NOT_FOUND", "Number not found", 404);
    // Cloud API numbers are registered with Meta, not paired by scanning a
    // code, and have no Evolution instance behind them to ask — without this
    // the call below fails against Evolution with an unreadable 404.
    if (number.integration === "cloud_api") {
      throw new ApiError(
        "BAD_REQUEST",
        "This is an official Cloud API number — there is no QR code to scan.",
        400,
      );
    }

    const wantsPairing = new URL(req.url).searchParams.get("pair") === "1";
    const connection = await getConnectionState(number.instanceName);

    if (connection.state === "open") {
      // Paired — clear the back-off so a later, genuine re-onboarding isn't
      // refused by a counter left over from this one.
      resetQrAttempts(number.instanceName);
      if (number.status !== "connected" || (connection.phoneNumber && !number.phoneNumber)) {
        await prisma.whatsAppNumber.update({
          where: { id: number.id },
          data: {
            status: "connected",
            phoneNumber: connection.phoneNumber ?? number.phoneNumber,
          },
        });
      }
      return ok({ state: connection.state, phoneNumber: connection.phoneNumber, qrCodeDataUrl: null });
    }

    if (number.status === "connected") {
      await prisma.whatsAppNumber.update({ where: { id: number.id }, data: { status: "disconnected" } });
    }

    if (!wantsPairing) {
      return ok({ state: connection.state, phoneNumber: null, qrCodeDataUrl: null, retryAfterSec: 0 });
    }

    try {
      const qr = await getQrCode(number.instanceName);
      return ok({
        state: qr.state,
        phoneNumber: null,
        qrCodeDataUrl: qr.qrCodeDataUrl,
        retryAfterSec: Math.ceil(qrCooldownRemaining(number.instanceName) / 1000),
      });
    } catch (err) {
      if (err instanceof QrCooldownError) {
        // Not an error the operator can fix by retrying — hand back the wait
        // so the dialog can count down and stop polling instead.
        return ok({
          state: connection.state,
          phoneNumber: null,
          qrCodeDataUrl: null,
          retryAfterSec: Math.ceil(err.retryAfterMs / 1000),
        });
      }
      throw err;
    }
  });
}
