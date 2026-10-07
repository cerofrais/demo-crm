/**
 * The image or audio behind a message row in an activity log.
 *
 * An Activity row records that a WhatsApp message was sent or received; the
 * file itself hangs off the Message. Only voice notes ever wrote the message's
 * id into the activity's metadata, so for every photo a guest has sent — and
 * for every voice note from before that was added — the activity log has no
 * way to reach the media at all. That is why the log showed a line of text
 * where a picture was.
 *
 * New rows carry `metadata.messageId` outright. Older ones are matched by
 * time: the Activity and the Message are written in the same request, within
 * milliseconds of each other, for the same guest and the same direction. The
 * window below is generous enough to survive a slow write and tight enough
 * that two messages a second apart cannot be confused — and a message already
 * claimed by one activity is never offered to a second.
 */
import { prisma } from "./prisma";

/** How far apart an Activity and its Message may be written. */
const MATCH_WINDOW_MS = 10_000;

export interface ActivityMedia {
  messageId: string;
  attachment: { id: string; filename: string; mimeType: string; sizeBytes: number } | null;
}

export interface ActivityRowLike {
  id: string;
  guestId: string | null;
  createdAt: Date;
  actionType: string;
  metadata: unknown;
}

/** The message id an activity names outright, if it names one. */
export function messageIdFromMetadata(metadata: unknown): string | null {
  const meta = metadata as { messageId?: unknown } | null | undefined;
  return typeof meta?.messageId === "string" ? meta.messageId : null;
}

function directionFor(actionType: string): "inbound" | "outbound" | null {
  if (actionType === "message_received") return "inbound";
  if (actionType === "message_sent") return "outbound";
  return null;
}

/**
 * Attachments for a page of activity rows, keyed by activity id.
 *
 * Two queries at most, whatever the page size: one for the messages named
 * outright, one for the guests and time span the rest fall in.
 */
export async function mediaForActivities(rows: ActivityRowLike[]): Promise<Map<string, ActivityMedia>> {
  const out = new Map<string, ActivityMedia>();

  const named = new Map<string, string>(); // activityId -> messageId
  const unnamed: ActivityRowLike[] = [];
  for (const row of rows) {
    const id = messageIdFromMetadata(row.metadata);
    if (id) named.set(row.id, id);
    else if (directionFor(row.actionType) && row.guestId) unnamed.push(row);
  }
  if (!named.size && !unnamed.length) return out;

  const select = {
    id: true,
    guestId: true,
    direction: true,
    createdAt: true,
    attachmentDocument: { select: { id: true, filename: true, mimeType: true, sizeBytes: true } },
  } as const;

  // A deleted message's media stays hidden, exactly as its body does.
  const byId = named.size
    ? await prisma.message.findMany({
        where: { id: { in: [...new Set(named.values())] }, deletedAt: null },
        select,
      })
    : [];
  const byIdMap = new Map(byId.map((m) => [m.id, m]));
  for (const [activityId, messageId] of named) {
    const m = byIdMap.get(messageId);
    if (m) out.set(activityId, { messageId, attachment: m.attachmentDocument ?? null });
  }

  if (!unnamed.length) return out;

  const times = unnamed.map((r) => r.createdAt.getTime());
  const rows2 = await prisma.message.findMany({
    where: {
      deletedAt: null,
      attachmentDocumentId: { not: null },
      guestId: { in: [...new Set(unnamed.map((r) => r.guestId!))] },
      createdAt: {
        gte: new Date(Math.min(...times) - MATCH_WINDOW_MS),
        lte: new Date(Math.max(...times) + MATCH_WINDOW_MS),
      },
    },
    select,
    orderBy: { createdAt: "asc" },
  });
  const candidates: CandidateMessage[] = rows2.map((m) => ({
    id: m.id,
    guestId: m.guestId,
    direction: m.direction,
    createdAt: m.createdAt,
    attachment: m.attachmentDocument ?? null,
  }));

  for (const [activityId, m] of matchByTime(unnamed, candidates)) {
    out.set(activityId, { messageId: m.id, attachment: m.attachment });
  }

  return out;
}

export interface CandidateMessage {
  id: string;
  guestId: string | null;
  direction: "inbound" | "outbound" | string;
  createdAt: Date;
  attachment: { id: string; filename: string; mimeType: string; sizeBytes: number } | null;
}

/**
 * Pair each activity with the closest message of the same guest and direction
 * written within the window — one message to one activity.
 *
 * Oldest activity first, so when two sit inside one window the earlier one
 * takes the earlier message rather than both reaching for the same row; a
 * message already taken is never offered again, which is what stops a guest
 * who sent three photos in a row from having the same one shown three times.
 */
export function matchByTime(
  activities: ActivityRowLike[],
  candidates: CandidateMessage[],
): Map<string, CandidateMessage> {
  const out = new Map<string, CandidateMessage>();
  const claimed = new Set<string>();

  for (const row of [...activities].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const direction = directionFor(row.actionType);
    if (!direction) continue;
    let best: CandidateMessage | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const m of candidates) {
      if (claimed.has(m.id)) continue;
      if (m.guestId !== row.guestId || m.direction !== direction) continue;
      const gap = Math.abs(m.createdAt.getTime() - row.createdAt.getTime());
      if (gap <= MATCH_WINDOW_MS && gap < bestGap) {
        best = m;
        bestGap = gap;
      }
    }
    if (!best) continue;
    claimed.add(best.id);
    out.set(row.id, best);
  }

  return out;
}
