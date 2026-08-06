import { NextRequest } from "next/server";
import { handle, ok, requirePermission, requireAnyPermission } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { referralSchema } from "@/lib/validation";
import { generateReferralCode, referralUrl } from "@/lib/referrals";

export const dynamic = "force-dynamic";

// GET /api/referrals — list codes with redemption counts (Manager/Admin, or read-only Viewer)
export async function GET() {
  return handle(async () => {
    await requireAnyPermission(["referrals.manage", "referrals.view"]);
    const codes = await prisma.referralCode.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { enquiries: true } } },
    });
    return ok(
      codes.map((c) => ({
        id: c.id,
        code: c.code,
        url: referralUrl(c.code),
        campaignLabel: c.campaignLabel,
        maxRedemptions: c.maxRedemptions,
        redemptionCount: c.redemptionCount,
        attachedEnquiries: c._count.enquiries,
        isActive: c.isActive,
        createdAt: c.createdAt.toISOString(),
      })),
    );
  });
}

// POST /api/referrals — generate a new code (Manager/Admin)
export async function POST(req: NextRequest) {
  return handle(async () => {
    await requirePermission("referrals.manage");
    const input = referralSchema.parse(await req.json());

    // Retry on the (astronomically unlikely) code collision.
    let code = generateReferralCode();
    for (let i = 0; i < 5; i++) {
      const exists = await prisma.referralCode.findUnique({ where: { code } });
      if (!exists) break;
      code = generateReferralCode();
    }

    const created = await prisma.referralCode.create({
      data: {
        code,
        campaignLabel: input.campaignLabel,
        maxRedemptions: input.maxRedemptions,
        issuedToGuestId: input.issuedToGuestId,
      },
    });
    return ok({ ...created, url: referralUrl(created.code) }, undefined, 201);
  });
}
