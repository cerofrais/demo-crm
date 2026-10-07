/**
 * Evolution API client — self-hosted WhatsApp gateway (Baileys/WhatsApp-Web
 * based). One "instance" = one connected WhatsApp number. Auth is a single
 * global API key (no OAuth token exchange, unlike keycloak-admin.ts) sent as
 * the `apikey` header on every call. See docs/17-whatsapp-integration.md.
 */
import { env } from "./env";
import { logger } from "./logger";
import { ApiError } from "./api";

const BASE = env.EVOLUTION_API_URL;

async function evoFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        apikey: env.EVOLUTION_API_KEY,
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    // fetch() only THROWS (vs returning a non-ok response) when the request
    // never reached the server at all — DNS failure, connection refused,
    // timeout. The one place that legitimately happens here is a box where
    // the evolution-api container isn't running (deliberate on the test
    // server, so it can't fight production for the live WhatsApp sessions).
    // Without this, every such call surfaced as an unhandled 500
    // ("Something went wrong") instead of saying what's actually missing.
    logger.error({ err, path }, "evolution: unreachable");
    throw new ApiError(
      "SERVICE_UNAVAILABLE",
      "The WhatsApp service (Evolution API) is not reachable on this server. On the test box it is intentionally kept stopped so it can't take over production's live WhatsApp sessions — use production for WhatsApp number management.",
      503,
    );
  }
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

/**
 * Creates a new QR-paired instance and returns its own token — does NOT wait
 * for the QR scan.
 *
 * Baileys only. Evolution can also front a Cloud API number
 * (integration: WHATSAPP-BUSINESS), and it used to here, but that mode is
 * just a proxy over graph.facebook.com — which this app now calls itself
 * (lib/whatsapp-cloud-api.ts) — while swallowing Cloud API delivery
 * statuses on the way back. Cloud API numbers no longer touch Evolution.
 */
export async function createInstance(instanceName: string): Promise<CreateInstanceResult> {
  const res = await evoFetchOk("/instance/create", {
    method: "POST",
    body: JSON.stringify({ instanceName, integration: "WHATSAPP-BAILEYS", qrcode: true }),
  });
  const data = await res.json();
  const instanceToken: string | undefined = data?.hash?.apikey ?? data?.hash;
  if (!instanceToken) {
    throw new Error("Evolution API did not return an instance token on create");
  }
  logger.info({ instanceName }, "evolution: instance created");
  return { instanceName, instanceToken };
}

export interface QrCodeResult {
  /** data:image/png;base64,... — ready to drop into an <img src>. */
  qrCodeDataUrl: string | null;
  state: "open" | "close" | "connecting" | "unknown";
}

/**
 * Onboarding back-off. Every call to /instance/connect makes WhatsApp issue a
 * NEW pairing code, and the admin page polls for one every 3 seconds — so a
 * QR dialog left open asks for roughly 1,200 codes an hour. Repeated pairing
 * attempts are one of the things WhatsApp scores as automated behaviour, and
 * on 2026-08-22 a number that was already restricted sat in exactly that loop.
 *
 * After MAX_QR_ATTEMPTS codes without a successful pairing, the instance is
 * put on ice for QR_COOLDOWN_MS. Enforced here rather than in the dialog
 * because a client-side limit is undone by a page refresh, and the point is to
 * stop the requests reaching WhatsApp at all.
 *
 * In-memory on purpose: this is a rate limiter, not a record. A deploy clears
 * it, which is acceptable — restarts are manual and infrequent, and the cost
 * of a reset is at most three extra codes.
 */
export const MAX_QR_ATTEMPTS = 3;
export const QR_COOLDOWN_MS = 5 * 60 * 1000;

const qrAttempts = new Map<string, { count: number; blockedUntil: number }>();

/** Milliseconds still to wait before this instance may ask for another code. */
export function qrCooldownRemaining(instanceName: string): number {
  const entry = qrAttempts.get(instanceName);
  if (!entry) return 0;
  return Math.max(0, entry.blockedUntil - Date.now());
}

/** Pairing succeeded (or the operator gave up and closed the dialog) — the
 *  next onboarding attempt starts from a clean slate. */
export function resetQrAttempts(instanceName: string): void {
  qrAttempts.delete(instanceName);
}

export class QrCooldownError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(
      `Too many pairing attempts. WhatsApp treats repeated QR requests as automated behaviour, ` +
        `so this number is paused for ${Math.ceil(retryAfterMs / 1000)}s before it can try again.`,
    );
    this.name = "QrCooldownError";
  }
}

/** Fetches (or re-generates) the pairing QR code for an instance not yet connected. */
export async function getQrCode(instanceName: string): Promise<QrCodeResult> {
  const remaining = qrCooldownRemaining(instanceName);
  if (remaining > 0) throw new QrCooldownError(remaining);

  const entry = qrAttempts.get(instanceName) ?? { count: 0, blockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_QR_ATTEMPTS) {
    // Counted BEFORE the request goes out, so the third code is handed over
    // and the block starts immediately after — rather than issuing a fourth
    // to discover the limit.
    entry.count = 0;
    entry.blockedUntil = Date.now() + QR_COOLDOWN_MS;
  }
  qrAttempts.set(instanceName, entry);

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
