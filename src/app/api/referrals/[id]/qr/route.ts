import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { requirePermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { referralUrl } from "@/lib/referrals";

export const dynamic = "force-dynamic";

// GET /api/referrals/:id/qr — PNG QR code for the referral link (Manager/Admin)
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  await requirePermission("referrals.manage");
  const code = await prisma.referralCode.findUnique({ where: { id: params.id } });
  if (!code) throw new ApiError("NOT_FOUND", "Referral code not found", 404);

  const png = await QRCode.toBuffer(referralUrl(code.code), {
    width: 320,
    margin: 2,
    color: { dark: "#1b4332", light: "#ffffff" },
  });

  return new NextResponse(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
