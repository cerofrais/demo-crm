/**
 * Direct Meta WhatsApp Cloud API client — everything a number connected via
 * the official Cloud API does, talking to graph.facebook.com itself (see
 * docs/17-whatsapp-integration.md). Evolution API is NOT in this path at all:
 * it stays behind the QR-paired Baileys numbers, which need its Web-protocol
 * implementation, while a Cloud API number is just HTTPS to Meta and gains
 * nothing from a proxy in front of it.
 *
 * Covers listing a WABA's approved message templates and sending one
 * (bulk/marketing outside an open 24h customer-service window must use an
 * approved template, which is the normal case for a broadcast), free-form
 * text and media sends inside that window, and downloading inbound media.
 * Inbound messages and delivery statuses arrive at
 * /api/webhooks/whatsapp-cloud (Meta's webhook, called by Meta directly).
 */
import { logger } from "./logger";

const META_GRAPH_VERSION = "v20.0";
const META_GRAPH_BASE = "https://graph.facebook.com";

async function metaFetchOk(url: string, accessToken: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Meta Graph API ${init?.method ?? "GET"} ${url} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return res;
}

export interface WhatsAppTemplateComponent {
  type: string; // HEADER | BODY | FOOTER | BUTTONS
  format?: string;
  text?: string;
  example?: { body_text?: string[][]; header_text?: string[] };
}

export interface WhatsAppTemplate {
  id: string;
  name: string;
  status: string; // APPROVED | PENDING | REJECTED | IN_APPEAL | PAUSED
  category: string; // MARKETING | UTILITY | AUTHENTICATION
  language: string;
  components: WhatsAppTemplateComponent[];
}

/** Every message template approved (or pending/rejected) for a WABA. */
export async function listMessageTemplates(
  wabaId: string,
  accessToken: string,
): Promise<WhatsAppTemplate[]> {
  const url = `${META_GRAPH_BASE}/${META_GRAPH_VERSION}/${wabaId}/message_templates?fields=name,status,category,language,components&limit=200`;
  const res = await metaFetchOk(url, accessToken);
  const data = await res.json();
  return (data?.data ?? []) as WhatsAppTemplate[];
}

export interface TemplateSendComponent {
  type: "header" | "body" | "button";
  /** `parameter_name` is required per Meta's contract for a NAMED-parameter
   *  template (e.g. {{customer_name}}) and omitted for a positional one
   *  (e.g. {{1}}), where array order alone identifies each parameter. A
   *  HEADER component with an image/video/document format uses the media
   *  variant instead of text, referencing an id from uploadMedia(). */
  parameters: (
    | { type: "text"; text: string; parameter_name?: string }
    | { type: "image"; image: { id: string } }
  )[];
  sub_type?: string;
  index?: string;
}

/**
 * Uploads media to Meta so it can be referenced by id in a template's HEADER
 * parameter — required for an IMAGE/VIDEO/DOCUMENT header, since Meta needs
 * an id or a publicly-fetchable link, not raw bytes inline in the send call.
 * Upload once per broadcast (not per recipient) — the same id is reused for
 * every send in that job, see broadcast.ts.
 */
export async function uploadMedia(
  phoneNumberId: string,
  accessToken: string,
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<{ mediaId: string }> {
  const url = `${META_GRAPH_BASE}/${META_GRAPH_VERSION}/${phoneNumberId}/media`;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Meta Graph API media upload -> ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return { mediaId: data.id };
}

/**
 * Whether marketing templates should go out over the Marketing Messages API
 * (MM Lite) instead of the Cloud API. Kill switch: unset/false keeps every
 * send on the Cloud API path, so this can be turned off without a deploy if
 * delivery gets worse rather than better.
 */
export function marketingApiEnabled(): boolean {
  return process.env.WHATSAPP_MM_API_ENABLED === "true";
}

/**
 * Sends an approved template message. `to` is E.164 (with +); converted
 * internally.
 *
 * `viaMarketingApi` switches the send to Meta's Marketing Messages API
 * (formerly MM Lite): the same request body, posted to `/marketing_messages`
 * instead of `/messages` on the same phone number id. That path runs the send
 * through Meta's engagement ranking — the same gate that rejects Cloud API
 * marketing sends with error 131049 ("in order to maintain a healthy
 * ecosystem engagement…"), which is the overwhelming majority of this
 * deployment's broadcast failures.
 *
 * Only MARKETING templates may use it; Meta rejects utility, authentication
 * and service templates on that endpoint, so the caller must check the
 * category first.
 */
export async function sendTemplateMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  templateName: string,
  languageCode: string,
  components?: TemplateSendComponent[],
  viaMarketingApi = false,
): Promise<{ externalId: string | null }> {
  const endpoint = viaMarketingApi ? "marketing_messages" : "messages";
  const url = `${META_GRAPH_BASE}/${META_GRAPH_VERSION}/${phoneNumberId}/${endpoint}`;
  const res = await metaFetchOk(url, accessToken, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      // Required by /marketing_messages and accepted (ignored) by /messages,
      // so it's sent unconditionally rather than branching the body shape.
      recipient_type: "individual",
      to: to.replace(/^\+/, ""),
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components?.length ? { components } : {}),
      },
    }),
  });
  const data = await res.json();
  const externalId: string | null = data?.messages?.[0]?.id ?? null;
  logger.info(
    { phoneNumberId, templateName, externalId, endpoint },
    "whatsapp cloud api: template sent",
  );
  return { externalId };
}

// ---------------------------------------------------------------------------
// Free-form (non-template) send + inbound media, direct to Meta
//
// These used to go through Evolution API's /message/sendText and
// /chat/getBase64FromMediaMessage even for Cloud API numbers, so a Cloud API
// message made two hops (CRM -> Evolution -> Meta) where only the second one
// carried any meaning: Evolution's Cloud API mode is a thin proxy over the
// very Graph endpoints below. That extra hop is also where Cloud API delivery
// statuses were being lost (Evolution v2.3.7 crashes normalizing them). Cloud
// API numbers now talk to Meta directly end to end; Evolution stays in place
// for the QR-paired Baileys numbers, which genuinely need it.
// ---------------------------------------------------------------------------

/** The Cloud API credentials a send needs, pulled off a WhatsAppNumber row. */
export interface CloudApiCreds {
  phoneNumberId: string;
  accessToken: string;
}

/**
 * Reads the Cloud API credentials off a number row, throwing a clear error
 * rather than letting an undefined phone-number-id build a Graph URL that
 * 404s with something unreadable. A cloud_api row without these was created
 * before the column existed, or had them cleared by hand.
 */
export function cloudApiCredsOf(number: {
  integration: string;
  metaPhoneNumberId: string | null;
  metaAccessToken: string | null;
  label: string;
}): CloudApiCreds {
  if (!number.metaPhoneNumberId || !number.metaAccessToken) {
    throw new Error(
      `WhatsApp number "${number.label}" is set to cloud_api but has no Meta Phone Number ID / access token`,
    );
  }
  return { phoneNumberId: number.metaPhoneNumberId, accessToken: number.metaAccessToken };
}

async function postMessage(
  creds: CloudApiCreds,
  payload: Record<string, unknown>,
): Promise<{ externalId: string | null }> {
  const url = `${META_GRAPH_BASE}/${META_GRAPH_VERSION}/${creds.phoneNumberId}/messages`;
  const res = await metaFetchOk(url, creds.accessToken, {
    method: "POST",
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
  });
  const data = await res.json();
  return { externalId: data?.messages?.[0]?.id ?? null };
}

/**
 * Free-form text — only deliverable inside an open 24h customer-service
 * window; outside it Meta rejects with 131047 and the caller must use
 * sendTemplateMessage instead. `preview_url` is on so a link in the body
 * renders as a rich preview, matching what Baileys does by default.
 */
export async function sendCloudApiText(
  creds: CloudApiCreds,
  to: string,
  text: string,
): Promise<{ externalId: string | null }> {
  return postMessage(creds, {
    to: to.replace(/^\+/, ""),
    type: "text",
    text: { preview_url: true, body: text },
  });
}

/**
 * Free-form media. Meta takes an uploaded media id (or a public link), never
 * inline bytes, so this uploads first and then sends — two calls where
 * Evolution's sendMedia was one, but the upload is the same one Meta's own
 * API requires and Evolution was doing it internally anyway.
 *
 * Audio deliberately goes out as `type: "audio"`, which is what renders as a
 * voice note on the recipient's phone — the equivalent of Evolution's
 * separate sendWhatsAppAudio endpoint. Meta ignores a caption on audio, so
 * one isn't sent.
 */
export async function sendCloudApiMedia(
  creds: CloudApiCreds,
  to: string,
  opts: { mimeType: string; fileName: string; base64: string; caption?: string },
): Promise<{ externalId: string | null }> {
  const buffer = Buffer.from(opts.base64, "base64");
  const { mediaId } = await uploadMedia(
    creds.phoneNumberId,
    creds.accessToken,
    buffer,
    opts.mimeType,
    opts.fileName,
  );
  const recipient = to.replace(/^\+/, "");
  const caption = opts.caption?.trim() || undefined;

  if (opts.mimeType.startsWith("audio/")) {
    return postMessage(creds, { to: recipient, type: "audio", audio: { id: mediaId } });
  }
  if (opts.mimeType.startsWith("image/")) {
    return postMessage(creds, { to: recipient, type: "image", image: { id: mediaId, caption } });
  }
  if (opts.mimeType.startsWith("video/")) {
    return postMessage(creds, { to: recipient, type: "video", video: { id: mediaId, caption } });
  }
  return postMessage(creds, {
    to: recipient,
    type: "document",
    document: { id: mediaId, caption, filename: opts.fileName },
  });
}

export interface CloudApiMedia {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Downloads an inbound media message's bytes. Meta's webhook carries only a
 * media id; resolving it is two hops — the id gives a short-lived lookaside
 * URL, and that URL still needs the bearer token to fetch. Both are done
 * here so callers see one call, mirroring getMediaBase64's shape for the
 * Baileys path.
 */
export async function fetchCloudApiMedia(
  creds: CloudApiCreds,
  mediaId: string,
): Promise<CloudApiMedia> {
  const metaUrl = `${META_GRAPH_BASE}/${META_GRAPH_VERSION}/${mediaId}`;
  const metaRes = await metaFetchOk(metaUrl, creds.accessToken);
  const meta = await metaRes.json();
  const url: string | undefined = meta?.url;
  if (!url) throw new Error(`Meta returned no download URL for media ${mediaId}`);

  // NOT metaFetchOk: the lookaside host rejects a request carrying
  // Content-Type: application/json on a GET, and the response is bytes.
  const fileRes = await fetch(url, { headers: { Authorization: `Bearer ${creds.accessToken}` } });
  if (!fileRes.ok) {
    throw new Error(`Meta media download ${mediaId} -> ${fileRes.status}`);
  }
  return {
    buffer: Buffer.from(await fileRes.arrayBuffer()),
    mimeType: meta?.mime_type ?? fileRes.headers.get("content-type") ?? "application/octet-stream",
  };
}
