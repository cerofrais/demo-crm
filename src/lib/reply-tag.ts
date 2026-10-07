import { prisma } from "./prisma";
import { logger } from "./logger";
import { addCustomTag } from "./tags-service";
import { slugifyTag } from "./lead-tags";

/**
 * Reply tags — campaign attribution for broadcasts.
 *
 * A broadcast (WhatsApp or bulk email) can carry a `replyTag`. It is NOT
 * applied when the message goes out: it's applied to the guest's LEAD only if
 * they actually reply, which is what makes it a signal worth filtering on
 * ("who responded to the Independence Day push").
 *
 * The tag is stamped onto every outbound Message the broadcast sends, so
 * resolution on the way back in is a plain lookup — and bulk email, which has
 * no BroadcastJob row, works the same way as WhatsApp.
 *
 * Matching an inbound message to the broadcast it answers, best first:
 *
 *  1. EXACT — the reply points at a specific message. Email gives us this
 *     reliably (In-Reply-To/References → Message-ID); WhatsApp gives it only
 *     when the guest used the quote/swipe-to-reply gesture.
 *  2. RECENT — no pointer, so attribute to the most recent tagged broadcast
 *     this guest received, within REPLY_WINDOW_DAYS. Most WhatsApp replies
 *     land here: people just type back rather than quoting. The window is
 *     what stops a reply months later being credited to an old campaign.
 *
 * Never throws — a tagging failure must not break inbound message storage.
 */

/** How long after a tagged broadcast an untargeted reply still counts as one. */
export const REPLY_WINDOW_DAYS = 14;

/**
 * Resolve which tag (if any) an inbound message earns, without applying it.
 * Split out from applyReplyTag so the matching rules are unit-testable
 * without a database.
 */
export function pickReplyTag(
  quoted: { replyTag: string | null } | null,
  recent: { replyTag: string | null } | null,
): string | null {
  return quoted?.replyTag ?? recent?.replyTag ?? null;
}

export async function applyReplyTag(params: {
  guestId: string;
  enquiryId?: string | null;
  channel: "whatsapp" | "email";
  /** WhatsApp: the quoted message's provider id. Email: In-Reply-To. */
  inReplyTo?: string | null;
  /** Email only — References, checked alongside In-Reply-To. */
  references?: string[];
  /** When the inbound arrived; only broadcasts BEFORE this can be replied to. */
  at?: Date;
}): Promise<string | null> {
  const { guestId, enquiryId, channel, inReplyTo, references = [], at = new Date() } = params;
  try {
    // A reply with no lead to tag: nothing to do. Inbound handlers normally
    // resolve or create one, so this is the rare orphan-guest path.
    if (!enquiryId) return null;

    // 1. Exact — the message this one answers, if it named one.
    const pointers = [...(inReplyTo ? [inReplyTo] : []), ...references].filter(Boolean);
    const quoted = pointers.length
      ? await prisma.message.findFirst({
          where: {
            guestId,
            direction: "outbound",
            replyTag: { not: null },
            // WhatsApp ids live in externalId, email Message-IDs in messageId.
            ...(channel === "whatsapp"
              ? { externalId: { in: pointers } }
              : { messageId: { in: pointers } }),
          },
          select: { replyTag: true },
        })
      : null;

    // 2. Recent — the newest tagged broadcast still inside the window.
    const recent = quoted
      ? null
      : await prisma.message.findFirst({
          where: {
            guestId,
            direction: "outbound",
            replyTag: { not: null },
            createdAt: {
              lt: at,
              gte: new Date(at.getTime() - REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000),
            },
          },
          orderBy: { createdAt: "desc" },
          select: { replyTag: true },
        });

    const tag = pickReplyTag(quoted, recent);
    if (!tag) return null;

    // Adding is idempotent (tags are a set), so a guest replying repeatedly
    // to the same campaign doesn't need guarding — but the activity row does,
    // or the lead's timeline fills with duplicates of the same event.
    const enquiry = await prisma.enquiry.findUnique({
      where: { id: enquiryId },
      select: { tags: true },
    });
    if (enquiry?.tags.includes(tag)) return tag;

    await addCustomTag(enquiryId, tag, "broadcast-reply");
    await prisma.activity.create({
      data: {
        enquiryId,
        guestId,
        actorSub: "broadcast-reply",
        actorRole: "system",
        actorName: "Broadcast reply",
        actionType: "reply_tagged",
        metadata: { tag, channel, matchedBy: quoted ? "quoted" : "recent" },
      },
    });
    logger.info({ guestId, enquiryId, tag, channel }, "reply tag applied");
    return tag;
  } catch (err) {
    logger.error({ err, guestId, enquiryId }, "reply tag failed");
    return null;
  }
}

/** Normalise a tag typed into a broadcast composer. Empty -> null (untagged). */
export function normalizeReplyTag(raw?: string | null): string | null {
  return raw ? slugifyTag(raw) || null : null;
}
