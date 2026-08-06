/**
 * POST /api/guests/bulk-delete — delete a batch of guests picked from the
 * Guests page's multi-select (the "N selected" trash icon). Same
 * soft/hard semantics and guests.delete permission as the single-guest
 * DELETE route (see lib/guest-delete.ts) — this just loops over the batch
 * and reports per-guest results instead of failing the whole request on the
 * first error.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission } from "@/lib/api";
import { deleteGuestRecord, type GuestDeleteMode } from "@/lib/guest-delete";

export const dynamic = "force-dynamic";

const schema = z.object({
  guestIds: z.array(z.string().uuid()).min(1).max(500),
  mode: z.enum(["soft", "hard"]).default("soft"),
});

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requirePermission("guests.delete");
    const { guestIds, mode } = schema.parse(await req.json());

    const failed: Array<{ id: string; error: string }> = [];
    let deleted = 0;
    for (const guestId of guestIds) {
      try {
        await deleteGuestRecord(guestId, mode as GuestDeleteMode, ctx.sub);
        deleted += 1;
      } catch (err) {
        failed.push({ id: guestId, error: err instanceof Error ? err.message : "Failed to delete" });
      }
    }

    return ok({ deleted, failed });
  });
}
