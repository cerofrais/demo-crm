import { prisma } from "./prisma";
import { transcriptExcerpt, transcriptStatusText, transcriptText } from "./voice-note";
import { voiceNoteTranscriptionEnabled } from "./ai/config";
import { formatLineNumber, getLineIndex, instancesForNumber, lineForMetadata } from "./whatsapp-lines";
import { mediaForActivities } from "./activity-media";

export interface ActivityFilters {
  actorSub?: string;
  actionType?: string;
  /** Narrows message actions to one channel — see parseActionTypeFilter. */
  channel?: string;
  /** Only voice notes (metadata.voiceNote) — see parseActionTypeFilter. */
  voiceNote?: boolean;
  /** Only WhatsApp activity on this line, as E.164 ("+918712623060"). */
  fromNumber?: string;
  dateFrom?: Date;
  dateTo?: Date;
  /** ISO createdAt of the last item on the previous page. */
  cursor?: string;
}

export interface ActivityListItemDTO {
  id: string;
  createdAt: string;
  actorSub: string;
  actorName: string;
  actorRole: string;
  actionType: string;
  actionLabel: string;
  enquiryId: string | null;
  guestName: string | null;
  /** The guest did this, not a staff member — a received voice note. The
   *  actor name is their WhatsApp display name, so the row has to say so. */
  byGuest?: boolean;
  /** The WhatsApp line a message went out from (or came in on), formatted
   *  for display — "+91 87126 23060". Absent for non-WhatsApp rows. */
  fromNumber?: string;
  /** A WhatsApp voice note — the row shows a mic and, once the background
   *  pass has run, what was actually said. */
  voiceNote?: {
    messageId: string;
    /** English transcript, trimmed for the table. Null while it has none. */
    transcript: string | null;
    /** "Transcribing…", or why there will never be one. Null once there is. */
    status: string | null;
  };
  /** The photo, voice note or file the message carried. The log shows an
   *  image and plays audio in place — see lib/activity-media.ts for how an
   *  older row, which never recorded its message id, is matched to it. */
  attachment?: { id: string; filename: string; mimeType: string; sizeBytes: number };
}

/** Human labels for known Activity.actionType values — falls back to a
 *  de-slugified version of the raw value for anything not listed here, so a
 *  newly-added actionType never renders as a blank cell. */
const ACTION_LABELS: Record<string, string> = {
  created: "Lead created",
  stage_change: "Stage changed",
  note: "Note added",
  message_sent: "Message sent",
  message_received: "Message received",
  message_edited: "Message edited",
  message_deleted: "Message deleted",
  task_created: "Task created",
  task_deleted: "Task deleted",
  doc_upload: "Document uploaded",
  doc_download: "Document downloaded",
  assign: "Lead assigned",
  contact_update: "Contact info updated",
  booking_update: "Booking details updated",
  health_update: "Health record updated",
  deletion_decision: "Deletion approved/denied",
  doctor_decision: "Doctor decision recorded",
  auto_deleted: "Lead auto-deleted",
  lead_revived: "Lead revived",
  call_missed: "Call missed",
  call_made: "Call made",
  call_answered: "Call answered",
  whatsapp_call_opened: "WhatsApp call log opened",
  bulk_email_sent: "Bulk email sent",
  duplicate_merged: "Duplicate submission merged",
  reply_tagged: "Tagged from a broadcast reply",
  auto_tagged: "Tagged from an inbound message",
};

/**
 * Channel-specific wording for the message_* actions. "Message sent" is the
 * same row whether a rep emailed a quote or sent a WhatsApp reply, which made
 * the log unreadable for the question people actually bring to it — "how did
 * we last contact this lead?". The channel is already on the Activity's
 * metadata; this just uses it.
 *
 * Each channel spells its own phrasing rather than prefixing a shared noun:
 * "WhatsApp message sent" reads naturally, "Email message sent" does not.
 */
const CHANNEL_MESSAGE_LABELS: Record<string, Record<string, string>> = {
  whatsapp: {
    message_sent: "WhatsApp message sent",
    message_received: "WhatsApp message received",
    message_edited: "WhatsApp message edited",
    message_deleted: "WhatsApp message deleted",
  },
  email: {
    message_sent: "Email sent",
    message_received: "Email received",
    message_edited: "Email edited",
    message_deleted: "Email deleted",
  },
};

/**
 * `metadata` is the Activity's own metadata column. Optional: older rows
 * predate the channel being recorded, and message_edited/message_deleted only
 * started carrying one from 2026-09-03 — those fall back to the plain
 * "Message edited" rather than guessing a channel.
 */
export function formatActionLabel(actionType: string, metadata?: unknown): string {
  const meta = metadata as { channel?: unknown; voiceNote?: unknown } | null | undefined;
  // A voice note is its own kind of contact — "WhatsApp message sent" hides
  // the fact that nobody has read it yet.
  if (meta?.voiceNote === true) {
    if (actionType === "message_sent") return "Voice note sent";
    if (actionType === "message_received") return "Voice note received";
  }
  const channel = meta?.channel;
  if (typeof channel === "string") {
    const byChannel = CHANNEL_MESSAGE_LABELS[channel]?.[actionType];
    if (byChannel) return byChannel;
  }
  return ACTION_LABELS[actionType] ?? actionType.replace(/_/g, " ");
}

/**
 * actionType/label pairs for the filter dropdown — only the known ones, since
 * an unlisted actionType is by definition not something a user could pick to
 * filter on anyway.
 *
 * `message_sent` is expanded per channel, so "Email sent" and "WhatsApp
 * message sent" are separately selectable rather than collapsing into one
 * "Message sent" row that answers neither question. The value carries the
 * channel after a colon ("message_sent:email"); parseActionTypeFilter splits
 * it again server-side.
 *
 * Only message_sent is split. Every one of its 4,939 rows records a channel,
 * so the two options together lose nothing — whereas message_edited and
 * message_deleted have never recorded one (they only started on 2026-09-03),
 * and offering a channel filter for them would return zero rows for
 * everything already in the log.
 */
const CHANNEL_SPLIT_ACTIONS = ["message_sent"] as const;

/** Filter values for the voice-note rows, which are a metadata flag rather
 *  than an actionType of their own. */
const VOICE_NOTE_OPTIONS: [string, string][] = [
  ["message_sent:voice", "Voice note sent"],
  ["message_received:voice", "Voice note received"],
];

export const ACTION_TYPE_OPTIONS: [string, string][] = [
  ...Object.entries(ACTION_LABELS).flatMap(([type, label]) =>
    (CHANNEL_SPLIT_ACTIONS as readonly string[]).includes(type)
      ? Object.entries(CHANNEL_MESSAGE_LABELS).map(
          ([channel, labels]): [string, string] => [`${type}:${channel}`, labels[type] ?? label],
        )
      : [[type, label] as [string, string]],
  ),
  ...VOICE_NOTE_OPTIONS,
];

/**
 * Splits a dropdown value back into the actionType and optional channel it
 * encodes. A plain actionType (every other option, and any bookmarked URL
 * from before this existed) comes back with no channel and filters exactly as
 * it always did.
 */
export function parseActionTypeFilter(
  raw: string | undefined | null,
): { actionType?: string; channel?: string; voiceNote?: boolean } {
  if (!raw) return {};
  const [actionType, qualifier] = raw.split(":");
  // "voice" is not a channel — a voice note is a WhatsApp message carrying a
  // metadata flag, so it narrows on that instead.
  if (qualifier === "voice") return { actionType, voiceNote: true };
  return qualifier ? { actionType, channel: qualifier } : { actionType };
}

/** The Message a voice-note activity row was written for, if it is one. */
function voiceNoteMessageId(metadata: unknown): string | null {
  const meta = metadata as { voiceNote?: unknown; messageId?: unknown } | null | undefined;
  return meta?.voiceNote === true && typeof meta.messageId === "string" ? meta.messageId : null;
}

/**
 * Transcripts for a page of activity rows, keyed by message id. One query for
 * the page; rows whose message has since been deleted simply get no entry and
 * render as a plain voice-note row.
 */
async function voiceNoteTranscripts(
  metadatas: unknown[],
): Promise<Map<string, NonNullable<ActivityListItemDTO["voiceNote"]>>> {
  const ids = metadatas.map(voiceNoteMessageId).filter((id): id is string => !!id);
  if (!ids.length) return new Map();
  // deletedAt: null — a redacted message's body is hidden in the thread, so
  // its transcript must not resurface in the log that records the redaction.
  const rows = await prisma.message.findMany({
    where: { id: { in: [...new Set(ids)] }, deletedAt: null },
    select: {
      id: true,
      transcript: true,
      transcriptEnglish: true,
      transcriptError: true,
      transcriptAttempts: true,
      createdAt: true,
    },
  });
  const enabled = voiceNoteTranscriptionEnabled();
  return new Map(
    rows.map((m) => [
      m.id,
      {
        messageId: m.id,
        transcript: transcriptExcerpt(transcriptText(m)),
        status: transcriptStatusText(m, { enabled }),
      },
    ]),
  );
}

function voiceNoteFields(
  metadata: unknown,
  transcripts: Map<string, NonNullable<ActivityListItemDTO["voiceNote"]>>,
): Pick<ActivityListItemDTO, "voiceNote"> | Record<string, never> {
  const messageId = voiceNoteMessageId(metadata);
  if (!messageId) return {};
  return { voiceNote: transcripts.get(messageId) ?? { messageId, transcript: null, status: null } };
}

function whatsappLineField(
  metadata: unknown,
  numberByInstance: ReadonlyMap<string, string>,
): Pick<ActivityListItemDTO, "fromNumber"> | Record<string, never> {
  const channel = (metadata as { channel?: unknown } | null | undefined)?.channel;
  if (channel !== "whatsapp") return {};
  const number = lineForMetadata(metadata, numberByInstance);
  return number ? { fromNumber: formatLineNumber(number) } : {};
}

/** Cursor-paginated activity feed for the admin/manager Activity Log page —
 *  mirrors listAiDecisions()'s shape (same createdAt-cursor approach). */
export async function listActivity(
  filters: ActivityFilters,
  limit = 50,
): Promise<{ items: ActivityListItemDTO[]; nextCursor: string | null }> {
  // Lines are matched by number, never by instance name: a line gets a new
  // instance every time it is re-paired — see lib/whatsapp-lines.ts.
  const lines = await getLineIndex();
  const lineFilter = filters.fromNumber
    ? {
        OR: [
          { metadata: { path: ["line"], equals: filters.fromNumber } },
          ...instancesForNumber(filters.fromNumber, lines.numberByInstance).map((instance) => ({
            metadata: { path: ["instance"], equals: instance },
          })),
        ],
      }
    : null;

  // Filtering by a staff member is asking for that person's actions, so the
  // guest exception doesn't apply to it.
  const receivedVoiceNoteFilter = filters.actorSub
    ? null
    : {
        actionType: "message_received",
        metadata: { path: ["voiceNote"], equals: true },
      };

  const rows = await prisma.activity.findMany({
    where: {
      // Staff actions, plus received voice notes.
      //
      // Everything else automated/system-logged stays out, same reasoning as
      // the Performance report's notSystem filter: background jobs and
      // inbound-message webhooks write Activity rows too (auto-assign,
      // auto-revive, missed calls, the dead-lead sweep), and for inbound
      // WhatsApp actorName is the GUEST's own display name/phone — which in
      // a Staff column reads as if the lead performed the action.
      //
      // A received voice note is the exception worth making: it is a piece of
      // speech nobody has necessarily listened to, and the whole point of
      // transcribing it is that it can be read here. Rows like this are
      // flagged byGuest so the column can say whose name it is.
      OR: [
        { actorRole: { not: "system" } },
        ...(receivedVoiceNoteFilter ? [receivedVoiceNoteFilter] : []),
      ],
      ...(filters.actorSub && { actorSub: filters.actorSub }),
      ...(filters.actionType && { actionType: filters.actionType }),
      // Channel and the voice-note flag live on the Activity's own metadata,
      // so they are JSON path matches rather than columns. Both go through
      // AND because they'd otherwise overwrite each other's `metadata` key.
      AND: [
        ...(filters.channel
          ? [{ metadata: { path: ["channel"], equals: filters.channel } }]
          : []),
        ...(filters.voiceNote ? [{ metadata: { path: ["voiceNote"], equals: true } }] : []),
        ...(lineFilter ? [lineFilter] : []),
      ],
      ...((filters.dateFrom || filters.dateTo || filters.cursor) && {
        createdAt: {
          ...(filters.dateFrom && { gte: filters.dateFrom }),
          ...(filters.dateTo && { lte: filters.dateTo }),
          ...(filters.cursor && { lt: new Date(filters.cursor) }),
        },
      }),
    },
    include: {
      enquiry: { select: { id: true, guest: { select: { fullName: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  // Resolve the current display name for every actor in this page in one
  // batch, same reasoning as getStaffNamesBatch: actorName is a point-in-time
  // snapshot, so a renamed staff member's old rows should still show their
  // current name rather than looking like a different person per page.
  const subs = Array.from(new Set(items.map((r) => r.actorSub)));
  const staff = await prisma.staffProfile.findMany({
    where: { keycloakId: { in: subs } },
    select: { keycloakId: true, displayName: true },
  });
  const nameBySub = new Map(staff.map((s) => [s.keycloakId, s.displayName]));

  // Voice notes carry their transcript on the Message they came from, fetched
  // once for the whole page rather than per row.
  const [transcripts, media] = await Promise.all([
    voiceNoteTranscripts(items.map((r) => r.metadata)),
    mediaForActivities(items),
  ]);

  return {
    items: items.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      actorSub: r.actorSub,
      actorName: nameBySub.get(r.actorSub) ?? r.actorName ?? "Unknown",
      actorRole: r.actorRole,
      actionType: r.actionType,
      // Manual creations get called out: every OTHER "created" row in this
      // log is a staff-attributed auto-create (e.g. call routing), so the
      // label alone doesn't distinguish typing a lead in by hand.
      actionLabel:
        r.actionType === "created" && (r.metadata as { manual?: boolean } | null)?.manual
          ? "Lead created (manual)"
          : formatActionLabel(r.actionType, r.metadata),
      enquiryId: r.enquiryId,
      guestName: r.enquiry?.guest?.fullName ?? null,
      ...(r.actorRole === "system" && r.actionType === "message_received"
        ? { byGuest: true }
        : {}),
      ...whatsappLineField(r.metadata, lines.numberByInstance),
      // The mic still marks the row when the message itself has since been
      // deleted — it just has no transcript to show.
      ...voiceNoteFields(r.metadata, transcripts),
      ...(media.get(r.id)?.attachment ? { attachment: media.get(r.id)!.attachment! } : {}),
    })),
    nextCursor: hasMore ? items[items.length - 1].createdAt.toISOString() : null,
  };
}
