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

/** Sends an approved template message. `to` is E.164 (with +); converted internally. */
export async function sendTemplateMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  templateName: string,
  languageCode: string,
  components?: TemplateSendComponent[],
): Promise<{ externalId: string | null }> {
  const url = `${META_GRAPH_BASE}/${META_GRAPH_VERSION}/${phoneNumberId}/messages`;
  const res = await metaFetchOk(url, accessToken, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
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
  logger.info({ phoneNumberId, templateName, externalId }, "whatsapp cloud api: template sent");
  return { externalId };
}
