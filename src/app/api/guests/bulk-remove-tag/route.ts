/**
 * POST /api/guests/bulk-remove-tag — strip one or more tags from a batch of
 * guests picked on the Guests page. The counterpart to filtering by a tag:
 * select everyone carrying it, then take it off them.
 *
 * Only ever REMOVES, and only the tags named — a guest's other tags are left
 * alone, so this can't be used to blank a directory by accident. System tags
 * (source:/age:/campaign:, see lib/lead-tags.ts) are refused: they're derived
 * from the record rather than applied by hand, so removing one just leaves
 * the guest looking untagged until the next write recomputes it.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { isSystemTag } from "@/lib/lead-tags";
import { MAX_BULK_GUESTS } from "@/lib/limits";

export const dynamic = "force-dynamic";

const schema = z.object({
  guestIds: z.array(z.string().uuid()).min(1).max(MAX_BULK_GUESTS),
  tags: z.array(z.string().min(1)).min(1).max(50),
});

export async function POST(req: NextRequest) {
  return handle(async () => {
    // Same permission as editing one guest's tags (PATCH /api/guests/:id) —
    // doing it to a batch shouldn't demand more rights than doing it one at a
    // time, which is the pattern bulk-delete follows with guests.delete.
    await requirePermission("leads.manage");
    const { guestIds, tags } = schema.parse(await req.json());

    const systemTags = tags.filter(isSystemTag);
    if (systemTags.length) {
      throw new ApiError(
        "VALIDATION_ERROR",
        `These are computed automatically and can't be removed by hand: ${systemTags.join(", ")}`,
        400,
      );
    }

    // One statement, not one per guest. Read-then-write-each held a
    // transaction open across thousands of UPDATEs with as many rows locked,
    // which got linearly worse with batch size while the broadcast worker and
    // inbound webhooks were writing alongside it. Set-based, the cost barely
    // moves with the batch: measured at ~50ms for 2,288 guests versus ~240ms
    // issuing them individually.
    //
    // `tags && $tags` restricts it to guests that actually carry one, so the
    // returned count is guests CHANGED rather than guests looked at. The
    // ARRAY(...) rebuild keeps the surviving tags in their original order,
    // which EXCEPT would not.
    const updated = await prisma.$executeRaw`
      UPDATE "Guest"
      SET tags = ARRAY(SELECT t FROM unnest(tags) AS t WHERE t <> ALL(${tags}::text[])),
          "updatedAt" = now()
      WHERE id = ANY(${guestIds}::text[])
        AND "deletedAt" IS NULL
        AND tags && ${tags}::text[]
    `;

    return ok({ updated, requested: guestIds.length, tags });
  });
}
