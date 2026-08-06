/**
 * Evolution API client — self-hosted WhatsApp gateway (Baileys/WhatsApp-Web
 * based). One "instance" = one connected WhatsApp number. Auth is a single
 * global API key (no OAuth token exchange, unlike keycloak-admin.ts) sent as
 * the `apikey` header on every call. See docs/17-whatsapp-integration.md.
 */
import { env } from "./env";
import { logger } from "./logger";

const BASE = env.EVOLUTION_API_URL;

async function evoFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: env.EVOLUTION_API_KEY,
      ...(init?.headers ?? {}),
    },
  });
}

async function evoFetchOk(path: string, init?: RequestInit): Promise<Response> {
  const res = await evoFetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Evolution API ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

/** Slug a human label into a valid Evolution instanceName, unique enough in practice. */
export function slugifyInstanceName(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "number";
  return `tre-${base}-${Date.now().toString(36)}`;
}

export interface CreateInstanceResult {
  instanceName: string;
  instanceToken: string;
}

/** Official Meta Cloud API mode instead of QR-paired Baileys — see docs/17. */
export interface CloudApiConfig {
  /** Permanent System User access token for the WABA that owns this number. */
  token: string;
  /** Meta's Phone Number id (not the E.164 number itself). */
  phoneNumberId: string;
  /** Meta's WhatsApp Business Account id. */
  wabaId: string;
}

/**
 * Creates a new instance and returns its own token — does NOT wait for QR
 * pairing (Baileys mode only; a Cloud API instance is created already
 * "open", nothing to pair).
 */
export async function createInstance(
  instanceName: string,
  cloudApi?: CloudApiConfig,
): Promise<CreateInstanceResult> {
  const body = cloudApi
    ? {
        instanceName,
        integration: "WHATSAPP-BUSINESS",
        token: cloudApi.token,
        number: cloudApi.phoneNumberId,
        businessId: cloudApi.wabaId,
        qrcode: false,
      }
    : {
        instanceName,
        integration: "WHATSAPP-BAILEYS",
        qrcode: true,
      };
  const res = await evoFetchOk("/instance/create", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const instanceToken: string | undefined = data?.hash?.apikey ?? data?.hash;
  if (!instanceToken) {
    throw new Error("Evolution API did not return an instance token on create");
  }
  logger.info({ instanceName, cloudApi: Boolean(cloudApi) }, "evolution: instance created");
  return { instanceName, instanceToken };
}

export interface QrCodeResult {
  /** data:image/png;base64,... — ready to drop into an <img src>. */
  qrCodeDataUrl: string | null;
  state: "open" | "close" | "connecting" | "unknown";
}

/** Fetches (or re-generates) the pairing QR code for an instance not yet connected. */
export async function getQrCode(instanceName: string): Promise<QrCodeResult> {
  const res = await evoFetchOk(`/instance/connect/${encodeURIComponent(instanceName)}`);
  const data = await res.json();
  const raw: string | undefined = data?.base64 ?? data?.qrcode?.base64;
  const qrCodeDataUrl = raw ? (raw.startsWith("data:") ? raw : `data:image/png;base64,${raw}`) : null;
  return { qrCodeDataUrl, state: normalizeState(data?.instance?.state ?? data?.state) };
}

function normalizeState(s: unknown): QrCodeResult["state"] {
  if (s === "open" || s === "close" || s === "connecting") return s;
  return "unknown";
}

export interface ConnectionState {
  state: "open" | "close" | "connecting" | "unknown";
  /** E.164-ish, as reported by Evolution once connected (format varies; caller normalizes). */
  phoneNumber: string | null;
}

/**
 * Polls connection state — "open" means the number is live and can send/receive.
 *
 * The phone number can't come from this same endpoint: /instance/connectionState
 * doesn't return owner info at all on this Evolution API version (confirmed
 * 2026-07-24 — its response is just `{instance:{instanceName,state}}`). It's
 * only available via /instance/fetchInstances, under `ownerJid` (a WhatsApp
 * JID like "918977766852@s.whatsapp.net", not a bare number) — every
 * previously-connected number was left with phoneNumber permanently null as
 * a result, silently breaking isInternalPhone() and the WhatsApp send-from
 * picker's "this is your own number" default. Only fetched once actually
 * open, since a disconnected/connecting instance has no owner yet.
 */
export async function getConnectionState(instanceName: string): Promise<ConnectionState> {
  const res = await evoFetchOk(`/instance/connectionState/${encodeURIComponent(instanceName)}`);
  const data = await res.json();
  const state = normalizeState(data?.instance?.state ?? data?.state);

  let phoneNumber: string | null = null;
  if (state === "open") {
    const info = await evoFetchOk(`/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`)
      .then((r) => r.json())
      .catch(() => null);
    const record = Array.isArray(info) ? info[0] : info;
    const ownerJid: string | undefined = record?.ownerJid ?? record?.owner;
    phoneNumber = ownerJid ? `+${ownerJid.replace(/\D/g, "")}` : null;
  }
  return { state, phoneNumber };
}

/** Disconnects the WhatsApp session but keeps the instance (can re-scan a QR to reconnect). */
export async function logoutInstance(instanceName: string): Promise<void> {
  await evoFetchOk(`/instance/logout/${encodeURIComponent(instanceName)}`, { method: "DELETE" });
  logger.info({ instanceName }, "evolution: instance logged out");
}

/** Fully removes the instance from Evolution API. Message history in our own DB is untouched. */
export async function deleteInstance(instanceName: string): Promise<void> {
  await evoFetchOk(`/instance/delete/${encodeURIComponent(instanceName)}`, { method: "DELETE" });
  logger.info({ instanceName }, "evolution: instance deleted");
}

/** Sends a plain-text WhatsApp message. `to` is E.164 (with +); converted internally. */
export async function sendText(
  instanceName: string,
  to: string,
  text: string,
): Promise<{ externalId: string | null }> {
  const number = to.replace(/^\+/, "");
  const res = await evoFetchOk(`/message/sendText/${encodeURIComponent(instanceName)}`, {
    method: "POST",
    body: JSON.stringify({ number, text }),
  });
  const data = await res.json();
  const externalId: string | null = data?.key?.id ?? null;
  return { externalId };
}

export interface MediaResult {
  base64: string;
  mimetype: string;
  fileName: string | null;
}

/**
 * Downloads (and decrypts) an inbound media message's bytes. WhatsApp media
 * is end-to-end encrypted — the webhook payload only has metadata, not raw
 * bytes, so this dedicated call is required. Deliberately NOT relying on
 * Evolution's inline "webhook_base64" option, which has multiple open
 * reliability issues across versions as of this writing.
 */
export async function getMediaBase64(
  instanceName: string,
  messageKey: { id: string; remoteJid?: string; fromMe?: boolean },
): Promise<MediaResult> {
  const res = await evoFetchOk(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceName)}`, {
    method: "POST",
    body: JSON.stringify({ message: { key: messageKey } }),
  });
  const data = await res.json();
  const base64: string | undefined = data?.base64;
  const mimetype: string | undefined = data?.mimetype;
  if (!base64 || !mimetype) {
    throw new Error("Evolution API did not return media base64/mimetype");
  }
  return { base64, mimetype, fileName: data?.fileName ?? null };
}

export type WhatsAppMediaType = "image" | "video" | "document";

/** Sends an image/video/document. `media` is raw base64 (no data: prefix). */
export async function sendMedia(
  instanceName: string,
  to: string,
  opts: { mediatype: WhatsAppMediaType; mimetype: string; media: string; fileName: string; caption?: string },
): Promise<{ externalId: string | null }> {
  const number = to.replace(/^\+/, "");
  const res = await evoFetchOk(`/message/sendMedia/${encodeURIComponent(instanceName)}`, {
    method: "POST",
    body: JSON.stringify({
      number,
      mediatype: opts.mediatype,
      mimetype: opts.mimetype,
      media: opts.media,
      fileName: opts.fileName,
      caption: opts.caption,
    }),
  });
  const data = await res.json();
  return { externalId: data?.key?.id ?? null };
}

/** Sends a native WhatsApp voice note (waveform UI on the recipient's end). */
export async function sendAudio(
  instanceName: string,
  to: string,
  media: string,
): Promise<{ externalId: string | null }> {
  const number = to.replace(/^\+/, "");
  const res = await evoFetchOk(`/message/sendWhatsAppAudio/${encodeURIComponent(instanceName)}`, {
    method: "POST",
    body: JSON.stringify({ number, audio: media, encoding: true }),
  });
  const data = await res.json();
  return { externalId: data?.key?.id ?? null };
}
