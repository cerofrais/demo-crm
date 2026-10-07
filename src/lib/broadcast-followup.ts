import { prisma } from "./prisma";
import { logger } from "./logger";

/**
 * Follow-up campaigns — the reminder that goes to guests who ENGAGED with a
 * campaign, were sent the details, and then went quiet.
 *
 * The audience is deliberately the warm end of the funnel, not the cold one.
 * A reminder like "isn't it time to buy your gift vouchers?" only makes sense
 * to someone who has already seen the vouchers: they tapped the button, the
 * CRM (or a rep) sent them the pricing, and nothing came back. Someone who
 * never responded to the original campaign has no idea what it refers to.
 *
 * Three conditions, all measured per guest:
 *
 *  1. ENGAGED — they came back to us after we messaged them. Optionally
 *     narrowed by `trigger` to a specific button ("Enquire Now" / "See
 *     details"), which is how Stage 2 was triggered in the first place.
 *  2. WE SPOKE LAST — our most recent contact is newer than theirs. That is
 *     what "we sent Stage 2 and they didn't answer" looks like in the data,
 *     and it holds however Stage 2 went out: the auto-reply for button
 *     clickers, or a rep typing it for someone who phoned in.
 *  3. QUIET — we haven't contacted them within `quietHours`, so a live
 *     conversation is never interrupted by an automated nudge.
 *
 * Resolved WHEN THE FOLLOW-UP STARTS, never at scheduling time: the whole
 * point is the wait in between, during which people keep replying and must
 * drop out of the list on their own.
 */

/** Don't nudge anyone we've contacted more recently than this. */
export const DEFAULT_QUIET_HOURS = 24;

export interface FollowUpAudience {
  /** Everyone the parent campaign tried to message. */
  targeted: number;
  /** Of those, the ones who came back to us — counted through the same
   *  `trigger` filter as the rest, so the preview's "tapped X" row can't
   *  claim more people than the send would actually consider. */
  engaged: number;
  /** Of the engaged, the ones we answered and who then went silent. */
  awaitingReply: number;
  /** awaitingReply minus anyone unreachable/blocked now. */
  guestIds: string[];
}

export interface GuestTimeline {
  /** Guest -> us, after the campaign reached them. */
  fromGuest: { at: Date; text: string }[];
  /** Us -> guest, after the campaign reached them (Stage 2 and anything since). */
  fromUs: { at: Date }[];
}

/** Did this guest come back to us — via the given button, if one is named? */
export function hasEngaged(timeline: GuestTimeline, trigger?: string | null): boolean {
  const t = trigger?.trim().toLowerCase();
  return t
    ? timeline.fromGuest.some((m) => m.text.toLowerCase().includes(t))
    : timeline.fromGuest.length > 0;
}

/**
 * Decide one guest's eligibility. Pure, so the rules are testable without a
 * database — this is the logic that decides whether a real customer gets an
 * automated nudge, so it's worth pinning down exactly.
 */
export function isAwaitingOurReply(
  timeline: GuestTimeline,
  opts: { trigger?: string | null; quietHours?: number; now?: Date } = {},
): boolean {
  const { trigger, quietHours = DEFAULT_QUIET_HOURS, now = new Date() } = opts;

  if (!hasEngaged(timeline, trigger)) return false; // Stage 3 would be meaningless

  const lastFromGuest = Math.max(...timeline.fromGuest.map((m) => m.at.getTime()));
  const lastFromUs = timeline.fromUs.length
    ? Math.max(...timeline.fromUs.map((m) => m.at.getTime()))
    : 0;

  // They answered us more recently than we answered them — the ball is in
  // OUR court, so this is a job for a rep, not an automated reminder.
  if (lastFromUs <= lastFromGuest) return false;

  // Still mid-conversation: we said something very recently, give it time.
  return now.getTime() - lastFromUs >= quietHours * 60 * 60 * 1000;
}

/**
 * Of the guests eligible right now, the ones this follow-up hasn't already
 * messaged. Only a ROLLING job needs this, and it is the single thing that
 * makes "each person gets the reminder once" true.
 *
 * Eligibility can't carry that guarantee by itself, and the way it fails is
 * quiet: sending the reminder makes US the last speaker, which parks the guest
 * for exactly quietHours — and then hands them back as eligible again, for the
 * same reason they qualified the first time. A guest who never replies would
 * be reminded every quietHours until the window shut.
 */
export function stillUnsent(eligible: string[], alreadyMessaged: Iterable<string>): string[] {
  const done = new Set(alreadyMessaged);
  return eligible.filter((id) => !done.has(id));
}

/** Resolve who a follow-up to `parentJobId` should go to, right now. */
export async function resolveFollowUpAudience(
  parentJobId: string,
  opts: { trigger?: string | null; quietHours?: number } = {},
): Promise<FollowUpAudience> {
  const parent = await prisma.broadcastJob.findUnique({
    where: { id: parentJobId },
    select: { id: true, guestIds: true },
  });
  if (!parent) return { targeted: 0, engaged: 0, awaitingReply: 0, guestIds: [] };

  // When each guest was messaged by the parent campaign. No delivery-status
  // filter here, unlike a cold-reminder: a guest who replied has self-evidently
  // received it, whatever Meta's receipts later said.
  const sent = await prisma.message.findMany({
    where: { broadcastJobId: parentJobId, direction: "outbound" },
    select: { guestId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const sentAt = new Map<string, Date>();
  for (const m of sent) {
    if (m.guestId && !sentAt.has(m.guestId)) sentAt.set(m.guestId, m.createdAt);
  }
  const ids = [...sentAt.keys()];
  if (!ids.length) return { targeted: parent.guestIds.length, engaged: 0, awaitingReply: 0, guestIds: [] };

  const earliest = new Date(Math.min(...[...sentAt.values()].map((d) => d.getTime())));

  const [messages, calls, contactable] = await Promise.all([
    prisma.message.findMany({
      where: { guestId: { in: ids }, createdAt: { gt: earliest } },
      select: { guestId: true, direction: true, body: true, createdAt: true },
    }),
    prisma.call.findMany({
      where: { guestId: { in: ids }, startedAt: { gt: earliest } },
      select: { guestId: true, direction: true, status: true, startedAt: true },
    }),
    prisma.guest.findMany({
      where: { id: { in: ids }, deletedAt: null, isBlocked: false, phone: { not: null } },
      select: { id: true },
    }),
  ]);

  const timelines = new Map<string, GuestTimeline>();
  const timelineFor = (guestId: string): GuestTimeline => {
    let t = timelines.get(guestId);
    if (!t) timelines.set(guestId, (t = { fromGuest: [], fromUs: [] }));
    return t;
  };

  for (const m of messages) {
    if (!m.guestId) continue;
    const since = sentAt.get(m.guestId);
    if (!since || m.createdAt <= since) continue;
    if (m.direction === "inbound") timelineFor(m.guestId).fromGuest.push({ at: m.createdAt, text: m.body ?? "" });
    else timelineFor(m.guestId).fromUs.push({ at: m.createdAt });
  }
  for (const c of calls) {
    if (!c.guestId) continue;
    const since = sentAt.get(c.guestId);
    if (!since || c.startedAt <= since) continue;
    // A call the guest placed is them reaching out; one we placed and they
    // answered is still a conversation we had, so it counts as our contact.
    const connected = c.status === "completed" || c.status === "connected";
    if (c.direction === "inbound") {
      timelineFor(c.guestId).fromGuest.push({ at: c.startedAt, text: "[called us]" });
    } else if (connected) {
      timelineFor(c.guestId).fromUs.push({ at: c.startedAt });
    }
  }

  const contactableIds = new Set(contactable.map((g) => g.id));
  let engaged = 0;
  let awaitingReply = 0;
  const guestIds: string[] = [];
  for (const guestId of ids) {
    const timeline = timelines.get(guestId) ?? { fromGuest: [], fromUs: [] };
    if (hasEngaged(timeline, opts.trigger)) engaged++;
    if (!isAwaitingOurReply(timeline, opts)) continue;
    awaitingReply++;
    if (contactableIds.has(guestId)) guestIds.push(guestId);
  }

  return { targeted: parent.guestIds.length, engaged, awaitingReply, guestIds };
}

/**
 * Fill in a follow-up job's recipient list at the moment it starts. Returns
 * false when nobody is left to message — the caller completes the job
 * instead of running it against an empty list.
 *
 * A ROLLING job calls this repeatedly rather than once, so it must never hand
 * back someone it has already messaged. Eligibility alone won't do that:
 * sending makes us the last speaker, which parks the guest for exactly
 * quietHours and then makes them eligible all over again — a reminder loop
 * every 48 hours forever. The sent-list check below is what stops it.
 */
export async function materializeFollowUp(
  jobId: string,
  parentJobId: string,
  opts: { trigger?: string | null; quietHours?: number; rolling?: boolean } = {},
): Promise<boolean> {
  const audience = await resolveFollowUpAudience(parentJobId, opts);
  let guestIds = audience.guestIds;
  let alreadyMessaged = 0;

  if (opts.rolling) {
    const sent = await prisma.message.findMany({
      where: { broadcastJobId: jobId, direction: "outbound" },
      select: { guestId: true },
    });
    const before = guestIds.length;
    guestIds = stillUnsent(guestIds, sent.map((m) => m.guestId).filter(Boolean) as string[]);
    alreadyMessaged = before - guestIds.length;
  }

  // A rolling job's total isn't knowable up front — people keep becoming due —
  // so it reads as "everyone handled so far, plus whoever is due right now".
  // A one-shot job's total is just this batch, as before.
  const job = opts.rolling
    ? await prisma.broadcastJob.findUnique({
        where: { id: jobId },
        select: { sentCount: true, failedCount: true },
      })
    : null;
  const totalCount = job
    ? job.sentCount + job.failedCount + guestIds.length
    : guestIds.length;

  await prisma.broadcastJob.update({
    where: { id: jobId },
    data: { guestIds, totalCount, cursor: 0 },
  });
  logger.info(
    {
      jobId,
      parentJobId,
      targeted: audience.targeted,
      engaged: audience.engaged,
      awaitingReply: audience.awaitingReply,
      recipients: guestIds.length,
      alreadyMessaged: opts.rolling ? alreadyMessaged : undefined,
      trigger: opts.trigger ?? null,
      rolling: opts.rolling ?? false,
    },
    "broadcast follow-up: audience resolved at start",
  );
  return guestIds.length > 0;
}
