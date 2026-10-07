/**
 * GET  /api/admin/whatsapp/numbers — list all numbers (admin fields, no token).
 * POST /api/admin/whatsapp/numbers — onboard a new number: creates the
 * Evolution instance, persists it as "pending", and returns it so the client
 * can immediately fetch its QR code.
 */
import { NextRequest } from "next/server";
import { handle, ok, ApiError, requirePermission, requireAnyPermission } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { createWhatsAppNumberSchema } from "@/lib/validation";
import { createInstance, slugifyInstanceName } from "@/lib/whatsapp-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toAdminDTO(n: {
  id: string; label: string; phoneNumber: string | null; instanceName: string;
  status: string; isDefault: boolean; shared: boolean; createdAt: Date;
  integration: string; wabaId: string | null;
}) {
  return {
    id: n.id,
    label: n.label,
    phoneNumber: n.phoneNumber,
    instanceName: n.instanceName,
    status: n.status,
    isDefault: n.isDefault,
    shared: n.shared,
    createdAt: n.createdAt.toISOString(),
    integration: n.integration,
    wabaId: n.wabaId,
  };
}

export async function GET() {
  return handle(async () => {
    await requireAnyPermission(["whatsapp.manage", "whatsapp.view"]);
    const numbers = await prisma.whatsAppNumber.findMany({ orderBy: { createdAt: "asc" } });
    return ok(numbers.map(toAdminDTO));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requirePermission("whatsapp.manage");
    const { label, cloudApi } = createWhatsAppNumberSchema.parse(await req.json());

    const instanceName = slugifyInstanceName(label);

    if (cloudApi) {
      // Confirm the token/number actually work against Meta before creating
      // anything — a bad token here would otherwise show up as a silently
      // broken "connected" number with no way to tell why sends fail.
      const check = await fetch(
        `https://graph.facebook.com/v20.0/${cloudApi.phoneNumberId}?fields=display_phone_number,code_verification_status`,
        { headers: { Authorization: `Bearer ${cloudApi.token}` } },
      );
      if (!check.ok) {
        const text = await check.text().catch(() => "");
        throw new ApiError(
          "BAD_REQUEST",
          `Meta rejected this token/Phone Number ID: ${text.slice(0, 300)}`,
          400,
        );
      }
      const info = await check.json();
      if (info.code_verification_status !== "VERIFIED") {
        throw new ApiError(
          "BAD_REQUEST",
          `Phone number is not yet verified with Meta (status: ${info.code_verification_status}) — finish registration in Meta's console first.`,
          400,
        );
      }

      // No Evolution instance is created: a Cloud API number talks to Meta
      // directly in both directions (lib/whatsapp-cloud-api.ts for sends,
      // /api/webhooks/whatsapp-cloud for inbound and statuses). instanceName
      // is still needed — it is this number's Message.mailboxId — but there
      // is no Evolution-scoped token behind it, hence the marker below rather
      // than a secret that doesn't exist.
      const number = await prisma.whatsAppNumber.create({
        data: {
          label,
          phoneNumber: `+${String(info.display_phone_number).replace(/\D/g, "")}`,
          instanceName,
          instanceToken: "cloud-api",
          status: "connected",
          integration: "cloud_api",
          wabaId: cloudApi.wabaId,
          metaPhoneNumberId: cloudApi.phoneNumberId,
          metaAccessToken: cloudApi.token,
          createdBy: ctx.sub,
        },
      });
      return ok(toAdminDTO(number), undefined, 201);
    }

    const { instanceToken } = await createInstance(instanceName);
    const number = await prisma.whatsAppNumber.create({
      data: {
        label,
        instanceName,
        instanceToken,
        status: "pending",
        createdBy: ctx.sub,
      },
    });
    return ok(toAdminDTO(number), undefined, 201);
  });
}
