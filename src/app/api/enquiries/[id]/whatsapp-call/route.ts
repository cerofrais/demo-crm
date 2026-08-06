import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST /api/enquiries/:id/whatsapp-call — audit log only. The
 * WhatsAppCallButton opens a wa.me link client-side (no CRM data changes),
 * so this just records that it happened, same as doc_download does for file
 * downloads — a read-tier permission (leads.view) is enough since the
 * number was already visible to anyone who can open this lead's drawer.
 */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view")) {
      throw new ApiError("FORBIDDEN", "No access", 403);
    }

    const enquiry = await prisma.enquiry.findUnique({
      where: { id: params.id },
      select: { guestId: true },
    });
    if (!enquiry) throw new ApiError("NOT_FOUND", "Enquiry not found", 404);

    await prisma.$transaction([
      prisma.activity.create({
        data: {
          enquiryId: params.id,
          guestId: enquiry.guestId,
          actorSub: ctx.sub,
          actorRole: ctx.roles[0] ?? "STAFF",
          actorName: ctx.name,
          actionType: "whatsapp_call_opened",
          metadata: {},
        },
      }),
      prisma.enquiry.update({
        where: { id: params.id },
        data: { lastActivityAt: new Date() },
      }),
    ]);

    return ok({ logged: true });
  });
}
