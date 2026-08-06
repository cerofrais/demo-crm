/**
 * GET /api/admin/whatsapp/numbers/:id/qr — fetch the pairing QR code + current
 * connection state. The admin page polls this every couple seconds while the
 * QR is on screen; once state flips to "open" we persist the detected phone
 * number and mark the row "connected".
 */
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { getQrCode, getConnectionState } from "@/lib/whatsapp-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    await requirePermission("whatsapp.manage");
    const number = await prisma.whatsAppNumber.findUnique({ where: { id: params.id } });
    if (!number) throw new ApiError("NOT_FOUND", "Number not found", 404);

    const connection = await getConnectionState(number.instanceName);

    if (connection.state === "open") {
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

    const qr = await getQrCode(number.instanceName);
    return ok({ state: qr.state, phoneNumber: null, qrCodeDataUrl: qr.qrCodeDataUrl });
  });
}
