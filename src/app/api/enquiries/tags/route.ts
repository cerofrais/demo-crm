/**
 * GET /api/enquiries/tags — every distinct tag a live lead can be filtered by.
 * Feeds the boards tag filter and the marketing reports tag picker.
 *
 * Unlike /api/tags (the shared CUSTOM vocabulary, for the add-tag
 * autocomplete) this returns what leads actually carry, system tags
 * included — `source:instagram`, `revisit`, `campaign:*` and so on are
 * exactly what a marketing report wants to slice by.
 *
 * Delegates to listDistinctActiveLeadTags(). It used to run its own raw
 * DISTINCT over Enquiry.tags instead, which is the same question asked a
 * second way — and the two drifted: the board filter resolves `?tag=` against
 * GUEST tags (see buildWhere), so everything living there was filterable but
 * never offered as an option. That covered the WhatsApp-number tags and the
 * broadcast "failed" tag, whose only route to the board was a hand-edited URL.
 */
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { listDistinctActiveLeadTags } from "@/lib/enquiries";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view")) throw new ApiError("FORBIDDEN", "No access", 403);
    return ok(await listDistinctActiveLeadTags());
  });
}
