import { prisma } from "./prisma";
import { logger } from "./logger";

/**
 * The "failed" guest tag — a live worklist of people a broadcast could not
 * reach, so they can be filtered and re-sent to from the Guests page rather
 * than dug out of each job's error list one campaign at a time.
 *
 * A plain custom slug, deliberately un-namespaced (same reasoning as
 * packageTag in lead-tags.ts): staff filter and bulk-remove it through the
 * ordinary tag UI, so it must not be a protected system tag.
 *
 * WHERE FAILURES ACTUALLY COME FROM — the reason this hangs off the delivery
 * webhook and not just the send loop. A broadcast send can fail two ways:
 *
 *   send-time      — we never got the message out at all (no phone on file,
 *                    no connected number, the Graph call threw). Recorded
 *                    synchronously by broadcast.ts's recordResult().
 *   after the fact — WhatsApp accepted the send and returned an id, then
 *                    reported the delivery failed. Arrives later on the
 *                    status webhook, via applyWhatsAppStatusUpdate().
 *
 * The second kind is essentially all of them: of 6,362 failed broadcast
 * messages on the live box, 6,359 were after-the-fact and 3 were send-time.
 * Tagging only the send loop would catch 0.05% of what staff actually mean
 * by "it failed", so both paths call in here.
 *
 * The tag CLEARS itself when a later message actually reaches the guest, so
 * the worklist drains as it gets worked instead of growing forever — see
 * clearBroadcastFailureTag for the ordering guard that keeps that honest.
 * Neither function throws: a tagging problem must never take down a
 * broadcast or drop a delivery webhook.
 */
export const BROADCAST_FAILED_TAG = "failed";

/**
 * Register the tag in the shared vocabulary so it appears in the tag filter
 * and the add-tag autocomplete (both read the Tag table — see
 * /api/tags). Once per process rather than once per guest: this is on the
 * path of every failure in a 7,000-recipient run.
 */
let vocabularyEnsured = false;
async function ensureVocabulary(): Promise<void> {
  if (vocabularyEnsured) return;
  await prisma.tag.upsert({
    where: { value: BROADCAST_FAILED_TAG },
    update: {},
    create: { value: BROADCAST_FAILED_TAG, category: "custom", createdBy: "system" },
  });
  vocabularyEnsured = true;
}

/**
 * Tag a guest whose broadcast message failed. Set-based and idempotent: the
 * WHERE clause makes a re-tag a no-op rather than a read-modify-write, so a
 * webhook retry can't churn updatedAt or duplicate the tag.
 */
export async function tagBroadcastFailure(guestId: string | null | undefined): Promise<void> {
  if (!guestId) return;
  try {
    await ensureVocabulary();
    await prisma.$executeRaw`
      UPDATE "Guest"
      SET tags = array_append(tags, ${BROADCAST_FAILED_TAG}),
          "updatedAt" = now()
      WHERE id = ${guestId}
        AND "deletedAt" IS NULL
        AND NOT (tags @> ARRAY[${BROADCAST_FAILED_TAG}]::text[])
    `;
  } catch (err) {
    logger.error({ err, guestId }, "broadcast failed-tag: could not tag guest");
  }
}

/**
 * Take the tag off once a message genuinely reached this guest (delivered or
 * read — NOT merely "sent", which is exactly the state that later flips to
 * failed).
 *
 * `reachedAt` is the delivered message's own createdAt, and the NOT EXISTS
 * below refuses to clear while the guest still has a broadcast failure NEWER
 * than it. Without that guard a late "delivered" webhook for last month's
 * campaign would quietly wipe the tag off someone this week's campaign just
 * failed to reach — silently shrinking the worklist is worse than leaving a
 * stale tag on it.
 */
export async function clearBroadcastFailureTag(
  guestId: string | null | undefined,
  reachedAt: Date,
): Promise<void> {
  if (!guestId) return;
  try {
    await prisma.$executeRaw`
      UPDATE "Guest" g
      SET tags = array_remove(g.tags, ${BROADCAST_FAILED_TAG}),
          "updatedAt" = now()
      WHERE g.id = ${guestId}
        AND g.tags @> ARRAY[${BROADCAST_FAILED_TAG}]::text[]
        AND NOT EXISTS (
          SELECT 1 FROM "Message" m
          WHERE m."guestId" = g.id
            AND m.channel = 'whatsapp'
            AND m.status = 'failed'
            AND m."broadcastJobId" IS NOT NULL
            AND m."createdAt" > ${reachedAt}
        )
    `;
  } catch (err) {
    logger.error({ err, guestId }, "broadcast failed-tag: could not clear guest tag");
  }
}
