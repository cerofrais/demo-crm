/**
 * Tagging a guest with the WhatsApp number(s) a conversation actually
 * happened on — "wa:918712623060", see whatsAppNumberTag() in lead-tags.ts
 * for why it's keyed on the number rather than Evolution's instance name.
 *
 * A guest ends up with none, one, or several: none if we've never reached
 * them on WhatsApp, several if the conversation moved between lines. That's
 * the point — a rep can then filter to "who did we actually talk to on the 60
 * line", which is also the question behind most of the 131047 failures (Meta
 * counts the 24-hour window per number, so replying from a line the guest
 * never wrote to is refused however recent the conversation looks).
 *
 * Applied wherever a WhatsApp Message row is created for a real exchange:
 * the two inbound webhooks (via whatsapp-ingest), the per-lead send route,
 * broadcasts, and auto-replies.
 *
 * FAILED sends deliberately don't count. A message Meta refused is not a
 * conversation, and on this deployment 10,755 of 15,510 Cloud API messages
 * are failures — counting them would put the Cloud API tag on nearly every
 * guest in the database and the filter would mean nothing.
 */
import { prisma } from "./prisma";
import { logger } from "./logger";
import { whatsAppNumberTag, WHATSAPP_TAG_PREFIX } from "./lead-tags";
import { getLineIndex } from "./whatsapp-lines";

/** Tag values already registered in the shared vocabulary this process. */
const registered = new Set<string>();

async function ensureVocabulary(tag: string): Promise<void> {
  if (registered.has(tag)) return;
  await prisma.tag.upsert({
    where: { value: tag },
    update: {},
    create: { value: tag, category: "whatsapp", createdBy: "system" },
  });
  registered.add(tag);
}

/**
 * Record that we exchanged a WhatsApp message with this guest on this number.
 *
 * Set-based and idempotent — the WHERE clause makes a re-tag a no-op rather
 * than a read-modify-write, so the hot path (every message, every broadcast
 * recipient) neither churns updatedAt nor races itself into a duplicate.
 *
 * Never throws: a tagging failure must not take down a send or drop an
 * inbound message.
 */
export async function tagWhatsAppNumberUsed(
  guestId: string | null | undefined,
  ourNumber: string | null | undefined,
): Promise<void> {
  if (!guestId) return;
  const tag = whatsAppNumberTag(ourNumber);
  if (!tag) return; // number never paired / unknown — nothing honest to tag with
  try {
    await ensureVocabulary(tag);
    await prisma.$executeRaw`
      UPDATE "Guest"
      SET tags = array_append(tags, ${tag}), "updatedAt" = now()
      WHERE id = ${guestId}
        AND "deletedAt" IS NULL
        AND NOT (tags @> ARRAY[${tag}]::text[])
    `;
  } catch (err) {
    logger.error({ err, guestId, tag }, "whatsapp number tag: could not tag guest");
  }
}

/**
 * Rebuild a guest's `wa:` line tags from the WhatsApp messages that actually
 * remain on file, leaving every other tag alone.
 *
 * tagWhatsAppNumberUsed only ever ADDS a tag, so anything that removes
 * messages must call this, or the tags go on describing conversations that no
 * longer exist — which is how a purged lead re-contacted on the 60 line came
 * back still tagged for the 61 line. Same rule as tagging: failed sends never
 * count.
 */
export async function recomputeWhatsAppLineTags(guestId: string): Promise<void> {
  const [guest, rows] = await Promise.all([
    prisma.guest.findUnique({ where: { id: guestId }, select: { tags: true } }),
    prisma.message.findMany({
      where: { guestId, channel: "whatsapp", status: { not: "failed" } },
      select: { direction: true, fromEmail: true, toEmail: true, mailboxId: true },
      distinct: ["mailboxId", "direction"],
    }),
  ]);
  if (!guest) return;

  const { numberByInstance } = await getLineIndex();
  const lines = new Set<string>();
  for (const m of rows) {
    // Our side of the exchange: the sender on outbound, the recipient on
    // inbound. Early inbound rows (July) never recorded it — their pairing
    // still resolves to the number.
    const ours = (m.direction === "outbound" ? m.fromEmail : m.toEmail) || numberByInstance.get(m.mailboxId);
    const tag = whatsAppNumberTag(ours);
    if (tag) lines.add(tag);
  }

  const next = [...guest.tags.filter((t) => !t.startsWith(WHATSAPP_TAG_PREFIX)), ...lines];
  const same = next.length === guest.tags.length && next.every((t) => guest.tags.includes(t));
  if (!same) await prisma.guest.update({ where: { id: guestId }, data: { tags: next } });
}
