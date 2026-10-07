/**
 * Meta WhatsApp Cloud API webhook payloads -> the channel-neutral shape
 * lib/whatsapp-ingest.ts stores.
 *
 * Kept apart from the route so the parsing is unit-testable without a
 * request, and apart from lib/whatsapp.ts because none of it is shared: Meta
 * and Baileys describe the same message in entirely different JSON. Meta's
 * envelope is
 *
 *   { entry: [ { changes: [ { field: "messages", value: {
 *       metadata: { phone_number_id },
 *       contacts: [ { wa_id, profile: { name } } ],
 *       messages: [ { from, id, timestamp, type, ... } ],
 *       statuses: [ { id, status, errors } ] } } ] } ] }
 *
 * — a single POST can carry several entries, several changes, and several
 * messages, so everything here flattens rather than reading index 0.
 */
import { extFor, MEDIA_LABEL } from "./whatsapp";

export interface MetaMediaObject {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
}

export interface MetaMessage {
  from?: string;
  id?: string;
  /** Unix SECONDS, as a string. */
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: MetaMediaObject;
  video?: MetaMediaObject;
  audio?: MetaMediaObject;
  document?: MetaMediaObject;
  sticker?: MetaMediaObject;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  contacts?: { profile?: { name?: string }; name?: { formatted_name?: string } }[];
  reaction?: { message_id?: string; emoji?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { title?: string };
    list_reply?: { title?: string };
  };
  order?: { product_items?: unknown[] };
  system?: { body?: string };
  errors?: { code?: number; title?: string; message?: string }[];
  /** The message this one replies to. */
  context?: { id?: string; from?: string };
}

export interface MetaStatusError {
  code?: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
}

export interface MetaStatus {
  id?: string;
  status?: string;
  errors?: MetaStatusError[];
}

export interface MetaContact {
  wa_id?: string;
  profile?: { name?: string };
}

export interface MetaValue {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: MetaContact[];
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
}

export interface MetaWebhookBody {
  entry?: { changes?: { value?: MetaValue }[] }[];
  /** Defensive fallback in case a value object is ever posted unwrapped. */
  metadata?: MetaValue["metadata"];
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
}

/** Every `value` object in the payload, across entries and changes. */
export function metaValues(body: MetaWebhookBody): MetaValue[] {
  const nested = (body.entry ?? []).flatMap((e) =>
    (e.changes ?? []).map((c) => c.value).filter((v): v is MetaValue => Boolean(v)),
  );
  if (nested.length) return nested;
  if (body.messages || body.statuses) {
    return [{ metadata: body.metadata, messages: body.messages, statuses: body.statuses }];
  }
  return [];
}

/** E.164 from Meta's bare-digits `from` / `wa_id`. */
export function toE164(waId: string): string {
  return `+${waId.replace(/\D/g, "")}`;
}

/** The sender's WhatsApp profile name, matched to this message by wa_id. */
export function contactNameFor(value: MetaValue, waId: string | undefined): string | null {
  if (!waId) return null;
  const match = value.contacts?.find((c) => c.wa_id === waId);
  return match?.profile?.name?.trim() || null;
}

export type MetaMediaKind = "image" | "video" | "audio" | "document" | "sticker";

export interface MetaMediaRef {
  kind: MetaMediaKind;
  mediaId: string;
  mimeType: string;
  fileName: string;
  caption: string | null;
}

/**
 * The downloadable media on a message, or null. Unlike Baileys, Meta only
 * hands over an id — the bytes come from a separate Graph call, see
 * fetchCloudApiMedia. `now` is injectable purely so generated filenames are
 * deterministic in tests.
 */
export function metaMediaOf(msg: MetaMessage, now = Date.now()): MetaMediaRef | null {
  const candidates: [MetaMediaKind, MetaMediaObject | undefined, string][] = [
    ["document", msg.document, "application/octet-stream"],
    ["image", msg.image, "image/jpeg"],
    ["video", msg.video, "video/mp4"],
    // A voice note and an uploaded audio file arrive on the same key; both
    // are stored the same way, and MEDIA_LABEL already calls it a voice
    // message, which is what it is in the overwhelming majority of cases.
    ["audio", msg.audio, "audio/ogg"],
    ["sticker", msg.sticker, "image/webp"],
  ];
  for (const [kind, obj, fallbackMime] of candidates) {
    if (!obj?.id) continue;
    const mimeType = (obj.mime_type ?? fallbackMime).split(";")[0].trim() || fallbackMime;
    const prefix =
      kind === "image" ? "photo" : kind === "audio" ? "voice" : kind === "sticker" ? "sticker" : kind;
    return {
      kind,
      mediaId: obj.id,
      mimeType,
      fileName: obj.filename?.trim() || `${prefix}-${now}.${extFor(mimeType)}`,
      caption: obj.caption?.trim() || null,
    };
  }
  return null;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Message.body for a Cloud API message that carries no downloadable media —
 * the Meta-shaped counterpart of describeNonMediaMessage(). Returns null for
 * anything genuinely unrecognised so the caller keeps its own fallback.
 */
export function describeMetaMessage(msg: MetaMessage): string | null {
  if (msg.text?.body) return msg.text.body;

  if (msg.reaction) {
    const emoji = msg.reaction.emoji?.trim();
    // An empty reaction body is WhatsApp's "reaction removed" signal.
    return emoji ? `Reacted ${emoji}` : "Removed a reaction";
  }
  if (msg.location) {
    const named = msg.location.name ?? msg.location.address;
    const coords =
      msg.location.latitude != null && msg.location.longitude != null
        ? `${msg.location.latitude.toFixed(5)}, ${msg.location.longitude.toFixed(5)}`
        : null;
    return `📍 Location${named ? `: ${named}` : ""}${coords ? ` (${coords})` : ""}`;
  }
  if (msg.contacts?.length) {
    if (msg.contacts.length > 1) return `👤 Shared ${plural(msg.contacts.length, "contact")}`;
    const c = msg.contacts[0];
    const name = c.profile?.name ?? c.name?.formatted_name;
    return `👤 Shared contact${name ? `: ${name}` : ""}`;
  }
  const reply =
    msg.interactive?.button_reply?.title ??
    msg.interactive?.list_reply?.title ??
    msg.button?.text;
  if (reply) return reply;
  if (msg.order) {
    const n = msg.order.product_items?.length;
    return `🛒 Order${n ? ` (${plural(n, "item")})` : ""}`;
  }
  if (msg.system?.body) return msg.system.body;
  // Meta's own "we couldn't process this" marker — it names the reason.
  if (msg.type === "unsupported" || msg.errors?.length) {
    const e = msg.errors?.[0];
    return `[Unsupported message${e?.title ? `: ${e.title}` : ""}]`;
  }
  return null;
}

/** Body text for any Cloud API message, media included. */
export function metaMessageBody(msg: MetaMessage, media: MetaMediaRef | null): string {
  if (media) return media.caption || MEDIA_LABEL[media.kind];
  return describeMetaMessage(msg) || "[Unsupported message type]";
}
