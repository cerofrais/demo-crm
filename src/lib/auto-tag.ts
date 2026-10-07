import { prisma } from "./prisma";
import { logger } from "./logger";
import { addCustomTag } from "./tags-service";
import { slugifyTag } from "./lead-tags";

/**
 * Auto-tagging — put a tag on a lead when an inbound WhatsApp message
 * matches a word or sentence, configured per number.
 *
 * Sibling of the auto-reply rules and matched the same way (case-insensitive
 * substring, so a whole sentence is just a longer needle), with one
 * deliberate difference: an auto-REPLY picks a single winner, because you can
 * only send one reply. Tags aren't exclusive — a message reading "what's the
 * price for a couple?" legitimately earns both `price-asked` and
 * `double-occupancy`, so EVERY matching rule applies.
 */

export interface AutoTagDTO {
  id: string;
  numberId: string;
  trigger: string;
  tag: string;
  enabled: boolean;
  createdAt: string;
}

function toDTO(row: {
  id: string; numberId: string; trigger: string; tag: string;
  enabled: boolean; createdAt: Date;
}): AutoTagDTO {
  return {
    id: row.id,
    numberId: row.numberId,
    trigger: row.trigger,
    tag: row.tag,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Every tag an inbound body earns. Pure (no I/O) so the matching rules are
 * testable without a database — this decides what ends up on a real lead's
 * record, so it's worth pinning down.
 *
 * Returns distinct tags: two rules pointing at the same tag shouldn't make it
 * appear twice, and a blank trigger never matches (it would tag everything,
 * which is what a catch-all auto-REPLY is for, not a tag).
 */
export function matchAutoTags<T extends { trigger: string; tag: string; enabled: boolean }>(
  rules: T[],
  body: string,
): string[] {
  const haystack = body.toLowerCase();
  const tags = rules
    .filter((r) => r.enabled && r.trigger.trim() && r.tag.trim())
    .filter((r) => haystack.includes(r.trigger.trim().toLowerCase()))
    .map((r) => r.tag);
  return Array.from(new Set(tags));
}

export async function listAutoTags(numberId?: string): Promise<AutoTagDTO[]> {
  const rows = await prisma.autoTag.findMany({
    where: numberId ? { numberId } : undefined,
    orderBy: [{ numberId: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toDTO);
}

export async function createAutoTag(input: {
  numberId: string;
  trigger: string;
  tag: string;
  createdBy: string;
}): Promise<AutoTagDTO> {
  const row = await prisma.autoTag.create({
    data: {
      numberId: input.numberId,
      trigger: input.trigger.trim(),
      // Slugified so it joins the shared vocabulary rather than minting a
      // near-duplicate of a tag staff already use by hand.
      tag: slugifyTag(input.tag),
      createdBy: input.createdBy,
    },
  });
  return toDTO(row);
}

export async function updateAutoTag(
  id: string,
  input: { trigger?: string; tag?: string; enabled?: boolean },
): Promise<AutoTagDTO> {
  const row = await prisma.autoTag.update({
    where: { id },
    data: {
      ...(input.trigger !== undefined && { trigger: input.trigger.trim() }),
      ...(input.tag !== undefined && { tag: slugifyTag(input.tag) }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    },
  });
  return toDTO(row);
}

export async function deleteAutoTag(id: string): Promise<void> {
  await prisma.autoTag.delete({ where: { id } });
}

/**
 * Called from the inbound WhatsApp webhook for genuine guest messages.
 * Best-effort: any failure is logged and swallowed, never thrown, so a
 * tagging problem can't break inbound message storage.
 */
export async function applyAutoTags(params: {
  numberId: string;
  guestId: string;
  enquiryId?: string | null;
  body: string;
}): Promise<string[]> {
  const { numberId, guestId, enquiryId, body } = params;
  try {
    if (!enquiryId || !body.trim()) return [];

    const rules = await prisma.autoTag.findMany({ where: { numberId, enabled: true } });
    const tags = matchAutoTags(rules, body);
    if (!tags.length) return [];

    const enquiry = await prisma.enquiry.findUnique({
      where: { id: enquiryId },
      select: { tags: true },
    });
    // Adding is idempotent, but the activity row isn't — without this a guest
    // who keeps saying "price" fills their timeline with the same entry.
    const fresh = tags.filter((t) => !(enquiry?.tags ?? []).includes(t));
    if (!fresh.length) return [];

    for (const tag of fresh) {
      await addCustomTag(enquiryId, tag, "auto-tag");
    }
    await prisma.activity.create({
      data: {
        enquiryId,
        guestId,
        actorSub: "auto-tag",
        actorRole: "system",
        actorName: "Auto-tag",
        actionType: "auto_tagged",
        metadata: { tags: fresh, channel: "whatsapp" },
      },
    });
    logger.info({ guestId, enquiryId, tags: fresh }, "auto-tag applied");
    return fresh;
  } catch (err) {
    logger.error({ err, guestId, enquiryId }, "auto-tag failed");
    return [];
  }
}
