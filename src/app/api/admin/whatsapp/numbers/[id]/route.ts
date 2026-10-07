/**
 * PATCH  /api/admin/whatsapp/numbers/:id — rename, or set as the default number.
 * DELETE /api/admin/whatsapp/numbers/:id — logs out + removes the Evolution
 * instance. Message history already sent through it is untouched (mailboxId
 * is a plain string, not an FK — same as deleting a Keycloak user account).
 */
import { NextRequest } from "next/server";
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { updateWhatsAppNumberSchema } from "@/lib/validation";
import { logoutInstance, deleteInstance, resetQrAttempts } from "@/lib/whatsapp-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    await requirePermission("whatsapp.manage");
    const input = updateWhatsAppNumberSchema.parse(await req.json());

    const current = await prisma.whatsAppNumber.findUnique({ where: { id: params.id } });
    if (!current) throw new ApiError("NOT_FOUND", "Number not found", 404);

    if (input.isDefault) {
      await prisma.whatsAppNumber.updateMany({
        where: { isDefault: true, id: { not: params.id } },
        data: { isDefault: false },
      });
    }

    const updated = await prisma.whatsAppNumber.update({
      where: { id: params.id },
      data: {
        label: input.label ?? undefined,
        isDefault: input.isDefault ?? undefined,
        shared: input.shared ?? undefined,
      },
    });
    return ok({
      id: updated.id,
      label: updated.label,
      phoneNumber: updated.phoneNumber,
      instanceName: updated.instanceName,
      status: updated.status,
      isDefault: updated.isDefault,
      shared: updated.shared,
      createdAt: updated.createdAt.toISOString(),
      integration: updated.integration,
      wabaId: updated.wabaId,
    });
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    await requirePermission("whatsapp.manage");
    const number = await prisma.whatsAppNumber.findUnique({ where: { id: params.id } });
    if (!number) throw new ApiError("NOT_FOUND", "Number not found", 404);

    await logoutInstance(number.instanceName).catch(() => null);
    await deleteInstance(number.instanceName).catch(() => null);
    resetQrAttempts(number.instanceName);
    await prisma.whatsAppNumber.delete({ where: { id: params.id } });

    return ok({ id: params.id });
  });
}
