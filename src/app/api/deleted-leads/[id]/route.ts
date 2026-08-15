/**
 * GET /api/deleted-leads/:id — everything retained for one soft-deleted lead:
 * activity trail, email + WhatsApp messages, calls with transcripts, notes,
 * tasks and documents. Same admin-only gate as the list route.
 *
 * Attachments and call recordings are not inlined here — the client links to
 * the existing /api/files/:id and /api/calls/:id/recording routes, which keep
 * their own permission checks and (for recordings) proxy the provider URL
 * rather than exposing it.
 */
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { getDeletedLead, hardDeleteLead } from "@/lib/deleted-leads";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.delete")) {
      throw new ApiError("FORBIDDEN", "Admin only", 403);
    }

    const lead = await getDeletedLead(params.id);
    // Also the answer for a lead that exists but isn't deleted — a live lead
    // must be read through the pipeline routes, which scope by stage/ownership.
    if (!lead) throw new ApiError("NOT_FOUND", "No deleted lead with that id", 404);
    return ok(lead);
  });
}

/**
 * DELETE /api/deleted-leads/:id — permanently purge an already-soft-deleted
 * lead and everything scoped to it. Irreversible, admin-only, and only
 * reachable for a lead that has already been soft-deleted, so a purge is
 * always a second deliberate step rather than a one-click destruction of a
 * live lead.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.delete")) {
      throw new ApiError("FORBIDDEN", "Admin only", 403);
    }

    const result = await hardDeleteLead(params.id, { sub: ctx.sub, name: ctx.name });
    if (!result) {
      throw new ApiError("NOT_FOUND", "No deleted lead with that id — a live lead can't be purged", 404);
    }
    return ok(result);
  });
}
