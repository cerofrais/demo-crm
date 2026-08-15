/**
 * Direct Meta WhatsApp Cloud API client — used only for numbers connected
 * via the official Cloud API (see docs/17-whatsapp-integration.md), not the
 * QR-paired Baileys numbers. Evolution API still owns instance lifecycle and
 * inbound webhook relay for these numbers (whatsapp-admin.ts /
 * /api/webhooks/whatsapp-cloud-relay) — this file talks to
 * graph.facebook.com directly for the two things Evolution doesn't cleanly
 * abstract across both integration modes: listing a WABA's approved message
 * templates, and sending one. Bulk/marketing sends on a Cloud API number
 * must use an approved template outside an open 24h customer-service
 * window, which is the normal case for a broadcast.
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
