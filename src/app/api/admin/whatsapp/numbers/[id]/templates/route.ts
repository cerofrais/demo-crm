/**
 * GET /api/admin/whatsapp/numbers/:id/templates — a Cloud-API-connected
 * number's Meta message templates (approved, pending, rejected — all of
 * them, so the UI can explain why a template isn't selectable rather than
 * just omitting it). Readable by the Guests broadcast composer (needs
 * messaging.send AND guests.view — see /api/guests/broadcast for why
 * messaging.send alone isn't enough), by a whatsapp.manage admin, or by a
 * read-only Viewer (whatsapp.view) from the WhatsApp Numbers admin page.
 */
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { listMessageTemplates } from "@/lib/whatsapp-cloud-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    const canBroadcast = can(ctx.roles, "messaging.send") && can(ctx.roles, "guests.view");
    const canAdminView = can(ctx.roles, "whatsapp.manage") || can(ctx.roles, "whatsapp.view");
    if (!canBroadcast && !canAdminView) {
      throw new ApiError("FORBIDDEN", "You cannot view message templates", 403);
    }

    const number = await prisma.whatsAppNumber.findUnique({ where: { id: params.id } });
    if (!number) throw new ApiError("NOT_FOUND", "Number not found", 404);
    if (number.integration !== "cloud_api" || !number.wabaId || !number.metaAccessToken) {
      throw new ApiError("BAD_REQUEST", "This number isn't connected via the official Cloud API", 400);
    }

    const templates = await listMessageTemplates(number.wabaId, number.metaAccessToken);
    return ok(
      templates.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        category: t.category,
        language: t.language,
        components: t.components,
      })),
    );
  });
}
