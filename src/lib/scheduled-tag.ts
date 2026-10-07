/**
 * Tagging by WHEN someone wrote in, not by what they said.
 *
 * The keyword auto-tags answer "they asked about price". This answers "they
 * came from the Diwali post": put a number on a campaign, open a window around
 * it, and everyone who messages that number while it runs carries the tag.
 * A keyword rule cannot do that job, because people answer an ad with "hi".
 *
 * Deliberately no content matching at all — the window IS the rule. The tag
 * lands on the lead, the same place every other tag lives, so the board's
 * filters and the reports see it without knowing anything about campaigns.
 */
import { prisma } from "./prisma";
import { logger } from "./logger";
import { addCustomTag } from "./tags-service";
import { slugifyTag } from "./lead-tags";

export interface ScheduledTagDTO {
  id: string;
  numberId: string;
  tag: string;
  label: string | null;
  startsAt: string;
  endsAt: string;
  enabled: boolean;
  /** Where the window sits relative to now — the list says so at a glance. */
  state: "running" | "upcoming" | "finished" | "off";
}

interface WindowLike {
  tag: string;
  startsAt: Date;
  endsAt: Date;
  enabled: boolean;
}

/**
 * The tags a message arriving at `at` earns. Inclusive of both ends: a window
 * someone set as 09:00–18:00 should include a message at exactly 18:00, which
 * is what they meant by "until six".
 */
export function tagsForMoment(rules: WindowLike[], at: Date): string[] {
  const ms = at.getTime();
  return [
    ...new Set(
      rules
        .filter((r) => r.enabled && ms >= r.startsAt.getTime() && ms <= r.endsAt.getTime())
        .map((r) => r.tag)
        .filter(Boolean),
    ),
  ];
}

export function windowState(rule: { enabled: boolean; startsAt: Date; endsAt: Date }, now = new Date()): ScheduledTagDTO["state"] {
  if (!rule.enabled) return "off";
  if (now < rule.startsAt) return "upcoming";
  if (now > rule.endsAt) return "finished";
  return "running";
}

function toDTO(r: {
  id: string;
  numberId: string;
  tag: string;
  label: string | null;
  startsAt: Date;
  endsAt: Date;
  enabled: boolean;
}): ScheduledTagDTO {
  return {
    id: r.id,
    numberId: r.numberId,
    tag: r.tag,
    label: r.label,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    enabled: r.enabled,
    state: windowState(r),
  };
}

export async function listScheduledTags(numberId?: string): Promise<ScheduledTagDTO[]> {
  const rows = await prisma.scheduledTag.findMany({
    where: numberId ? { numberId } : {},
    orderBy: [{ startsAt: "desc" }],
  });
  return rows.map(toDTO);
}

export async function createScheduledTag(input: {
  numberId: string;
  tag: string;
  label?: string | null;
  startsAt: Date;
  endsAt: Date;
  createdBy: string;
}): Promise<ScheduledTagDTO> {
  const row = await prisma.scheduledTag.create({
    data: {
      numberId: input.numberId,
      tag: slugifyTag(input.tag),
      label: input.label?.trim() || null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdBy: input.createdBy,
    },
  });
  return toDTO(row);
}

export async function updateScheduledTag(
  id: string,
  input: { enabled?: boolean; label?: string | null; startsAt?: Date; endsAt?: Date },
): Promise<ScheduledTagDTO> {
  const row = await prisma.scheduledTag.update({
    where: { id },
    data: {
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.label !== undefined && { label: input.label?.trim() || null }),
      ...(input.startsAt && { startsAt: input.startsAt }),
      ...(input.endsAt && { endsAt: input.endsAt }),
    },
  });
  return toDTO(row);
}

export async function deleteScheduledTag(id: string): Promise<void> {
  await prisma.scheduledTag.delete({ where: { id } });
}

/**
 * Called from the inbound WhatsApp webhook, beside applyAutoTags.
 *
 * Best-effort in the same way: a tagging failure must never cost us the
 * message itself. Re-applying is idempotent, and the activity row is only
 * written for tags the lead did not already carry, so a guest who messages
 * five times during a campaign gets one entry, not five.
 */
export async function applyScheduledTags(params: {
  numberId: string;
  guestId: string;
  enquiryId?: string | null;
  at?: Date;
}): Promise<string[]> {
  const { numberId, guestId, enquiryId } = params;
  try {
    if (!enquiryId) return [];
    const rules = await prisma.scheduledTag.findMany({ where: { numberId, enabled: true } });
    const tags = tagsForMoment(rules, params.at ?? new Date());
    if (!tags.length) return [];

    const enquiry = await prisma.enquiry.findUnique({ where: { id: enquiryId }, select: { tags: true } });
    const fresh = tags.filter((t) => !(enquiry?.tags ?? []).includes(t));
    if (!fresh.length) return [];

    for (const tag of fresh) await addCustomTag(enquiryId, tag, "scheduled-tag");
    await prisma.activity.create({
      data: {
        enquiryId,
        guestId,
        actorSub: "scheduled-tag",
        actorRole: "system",
        actorName: "Scheduled tag",
        actionType: "auto_tagged",
        metadata: { tags: fresh, channel: "whatsapp", scheduled: true },
      },
    });
    logger.info({ guestId, enquiryId, tags: fresh }, "scheduled tag applied");
    return fresh;
  } catch (err) {
    logger.error({ err, guestId, enquiryId }, "scheduled tag failed");
    return [];
  }
}
