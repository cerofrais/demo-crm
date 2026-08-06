/**
 * Plivo integration helpers — REST API client (native fetch) + XML builders.
 * No npm package needed; Plivo's API is plain HTTP/JSON + XML responses.
 */
import crypto from "node:crypto";

const AUTH_ID = process.env.PLIVO_AUTH_ID ?? "";
const AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN ?? "";
const PLIVO_NUMBER = process.env.PLIVO_PHONE_NUMBER ?? "";
const BASE = "https://api.plivo.com/v1";

function basicAuth(): string {
  return "Basic " + Buffer.from(`${AUTH_ID}:${AUTH_TOKEN}`).toString("base64");
}

// ---------------------------------------------------------------------------
// REST API calls
// ---------------------------------------------------------------------------

export interface PlivoCallCreateResult {
  requestUUID: string;
  message: string;
}

/** Initiate an outbound call. Plivo calls `to` first; when they answer the
 *  answerUrl webhook fires and we bridge to the customer. */
export async function createCall(opts: {
  to: string;               // rep's E.164 phone
  answerUrl: string;
  hangupUrl: string;
  customData: string;       // JSON blob echoed back in webhooks
  ringTimeout?: number;
}): Promise<PlivoCallCreateResult> {
  const res = await fetch(`${BASE}/Account/${AUTH_ID}/Call/`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: PLIVO_NUMBER,
      to: opts.to,
      answer_url: opts.answerUrl,
      answer_method: "POST",
      hangup_url: opts.hangupUrl,
      hangup_method: "POST",
      ring_timeout: opts.ringTimeout ?? 30,
      custom_data: opts.customData,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Plivo createCall ${res.status}: ${text}`);
  }
  const data = await res.json();
  return { requestUUID: data.request_uuid ?? data.requestUUID, message: data.message };
}

/**
 * Hangs up an in-progress call by its Plivo CallUUID. Used to release the
 * rep's leg when the customer's leg never connects — Conference-based
 * bridging (see outbound-answer) has no Dial-style "nothing left to
 * execute, so just hang up" fallthrough to rely on, unlike the old
 * <Dial><Number> flow. Tolerates 404 (call already ended naturally by the
 * time this runs).
 */
export async function hangupCall(callUUID: string): Promise<void> {
  const res = await fetch(`${BASE}/Account/${AUTH_ID}/Call/${callUUID}/`, {
    method: "DELETE",
    headers: { Authorization: basicAuth() },
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Plivo hangupCall ${res.status}: ${text}`);
  }
}

const PLIVO_API_HOSTS = new Set(["api.plivo.com"]);

function isPlivoApiHost(host: string): boolean {
  return PLIVO_API_HOSTS.has(host) || host.endsWith(".plivo.com");
}

/**
 * Reject URLs that could turn `fetchRecording` into an SSRF primitive:
 * non-https, loopback/link-local/private ranges, and bare/internal hostnames
 * (e.g. `minio`, `*.internal`) that only resolve inside our network.
 */
export function isSafeRecordingUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host.includes(":")) return false; // IPv6 literal (incl. ::ffff:127.0.0.1)
  if (!host.includes(".")) return false; // bare service names like "minio"
  // Recording URLs are always DNS-named Plivo/S3 hosts, never a bare IP. Require
  // an alphabetic TLD — this rejects every IP-literal encoding at once (dotted
  // decimal 127.0.0.1, octal 0177.0.0.1, hex 0x7f.0.0.1, decimal 2130706433).
  const labels = host.split(".");
  if (!/^[a-z]{2,}$/.test(labels[labels.length - 1])) return false;
  if (/(^|\.)(localhost|internal|local)$/.test(host)) return false;
  // NOTE: a public hostname that resolves to an internal IP (DNS rebinding)
  // is not caught here without resolving the name; the practical planting
  // vector is already gated by Plivo signature verification (F5).
  return true;
}

/**
 * Fetch a recording audio stream. Plivo API-hosted recordings need Basic auth;
 * S3/other hosts do not — and we must NOT leak the Plivo credential to a URL an
 * attacker may have planted on a call record. Internal/unsafe hosts are refused.
 */
export async function fetchRecording(recordingUrl: string): Promise<Response> {
  if (!isSafeRecordingUrl(recordingUrl)) {
    throw new Error("fetchRecording: refusing to fetch unsafe recording URL");
  }
  const host = new URL(recordingUrl).hostname.toLowerCase();
  const headers: Record<string, string> = {};
  if (isPlivoApiHost(host)) headers.Authorization = basicAuth();
  return fetch(recordingUrl, { headers, redirect: "error" });
}

// ---------------------------------------------------------------------------
// XML response builders
// ---------------------------------------------------------------------------

function xml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`, {
    headers: { "Content-Type": "application/xml" },
  });
}

/** E.164: leading + and 7-15 digits. Reject anything that could break out of XML. */
export function isE164(v: string | null | undefined): v is string {
  return !!v && /^\+[1-9]\d{6,14}$/.test(v);
}

/**
 * Plivo's inbound webhook `From` param is bare digits (e.g. "919876543210"),
 * not E.164 — but everywhere else in the CRM a phone is always `+`-prefixed
 * (Guest.phone, outbound Call.customerPhone, WhatsApp numbers). Without this,
 * an inbound call's customerPhone silently never matches its Guest record —
 * no guest name, no enquiry link, no assigned-owner routing, ever.
 */
export function normalizeInboundPhone(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) return trimmed;
  // Plivo usually reports the caller ID as bare digits WITH the country
  // code ("919876543210"), but depending on the originating
  // carrier/route it can arrive as a bare 10-digit LOCAL number with no
  // country code at all — a bare Indian mobile always starts 6-9, so that
  // case gets "91" prepended explicitly rather than just a "+", or the
  // stored customerPhone silently comes out one country code short of
  // Guest.phone/E.164 (e.g. "+9848052531" instead of "+919848052531").
  if (/^[6-9]\d{9}$/.test(trimmed)) return `+91${trimmed}`;
  return `+${trimmed}`;
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/**
 * Outbound, rep's leg: rep answered → record, then join the conference room
 * as moderator (starts it immediately even alone). `endConferenceOnExit` is
 * set on BOTH legs (see outboundCustomerConferenceXml) so whichever side
 * hangs up first ends it for the other too — otherwise a customer who hangs
 * up leaves the rep sitting alone in a live, silent conference indefinitely
 * (found 2026-07-23: a rep's leg stayed open 4+ minutes after the customer
 * left, with no hangup webhook ever firing to close it out).
 *
 * Conference-based rather than <Dial><Number> specifically so the customer's
 * leg can run its OWN answer_url (outbound-customer-answer) and play the
 * legally-required greeting before being bridged in — a plain <Number> noun
 * bridges on answer with no hook to inject a callee-specific message first.
 */
export function outboundRepConferenceXml(
  roomName: string,
  recordingCallbackUrl: string,
  waitSoundUrl: string,
): Response {
  // recordSession: a bare <Record> is a BLOCKING voicemail-style recorder —
  // it records only this leg's mic, stops after 15s of silence (or 60s max),
  // and never captures the conference audio. Found 2026-07-23: every outbound
  // "recording" was a few seconds of the rep talking to nobody (or their
  // carrier voicemail greeting) and the real conversation was never recorded.
  // recordSession records the whole call in the background until hangup;
  // maxLength still applies to session recordings (default 60s), so raise it.
  return xml(
    `<Record recordSession="true" maxLength="14400" callbackUrl="${recordingCallbackUrl}" callbackMethod="POST" />` +
    `<Speak voice="WOMAN" language="en-US">Connecting your customer now. This call will be recorded.</Speak>` +
    `<Conference startConferenceOnEnter="true" endConferenceOnExit="true" waitSound="${escapeXml(waitSoundUrl)}">${escapeXml(roomName)}</Conference>`,
  );
}

/** Outbound, customer's leg: plays the legally-required greeting, then joins
 *  the same room the rep is already waiting in. `endConferenceOnExit="true"`
 *  so the rep's leg is released the moment the customer hangs up, instead of
 *  being left alone in the room — see outboundRepConferenceXml. `waitSound`
 *  plays a soft tone instead of dead silence for whichever side is briefly
 *  alone in the room before the other joins. */
export function outboundCustomerConferenceXml(roomName: string, waitSoundUrl: string): Response {
  return xml(
    `<Speak voice="WOMAN" language="en-US">Welcome to Tre Wellness. This call may be recorded for training purposes.</Speak>` +
    `<Conference startConferenceOnEnter="false" endConferenceOnExit="true" waitSound="${escapeXml(waitSoundUrl)}">${escapeXml(roomName)}</Conference>`,
  );
}

/**
 * `waitSound` is NOT a direct audio-file URL — Plivo POSTs to it and expects
 * an XML document back containing Play/Speak/Wait elements (confirmed via
 * Plivo's docs, since the attribute alone silently plays nothing if pointed
 * straight at a .wav/.mp3). This is that XML response, looping the given
 * audio file for as long as a Conference leg is waiting alone.
 */
export function holdToneXml(audioUrl: string): Response {
  return xml(`<Play loop="0">${escapeXml(audioUrl)}</Play>`);
}

/** Inbound: customer called Plivo number → route to rep. */
export function inboundAnswerXml(
  repPhone: string,
  dialCallbackUrl: string,
  recordingCallbackUrl: string,
): Response {
  // maxLength: applies even to startOnDialAnswer session recordings and
  // defaults to 60s — without it inbound recordings silently cap at a minute.
  return xml(
    `<Speak voice="WOMAN" language="en-US">Welcome to Tre Wellness. This call may be recorded for training purposes.</Speak>` +
    `<Record startOnDialAnswer="true" maxLength="14400" callbackUrl="${recordingCallbackUrl}" callbackMethod="POST" />` +
    `<Dial action="${dialCallbackUrl}" method="POST" timeout="45">` +
    `<Number>${escapeXml(repPhone)}</Number>` +
    `</Dial>`,
  );
}

/**
 * Inbound hunt continuation: the previous rep didn't pick up and there's at
 * least one more eligible rep left to try — ring the next one. Deliberately
 * omits the welcome <Speak> (inboundAnswerXml's first line) since the caller
 * already heard it on the first attempt; repeating it on every hop would be
 * poor UX. <Record> is re-declared per hop since it's scoped to the <Dial>
 * verb it's paired with, not the call as a whole.
 */
export function huntNextRepXml(
  repPhone: string,
  dialCallbackUrl: string,
  recordingCallbackUrl: string,
): Response {
  return xml(
    `<Record startOnDialAnswer="true" maxLength="14400" callbackUrl="${recordingCallbackUrl}" callbackMethod="POST" />` +
    `<Dial action="${dialCallbackUrl}" method="POST" timeout="45">` +
    `<Number>${escapeXml(repPhone)}</Number>` +
    `</Dial>`,
  );
}

/** Plays a "no agents available" message and hangs up. */
export function noAgentXml(): Response {
  return xml(
    `<Speak voice="WOMAN" language="en-US">We are sorry, no agents are available right now. Please call back shortly or send us an email. Goodbye.</Speak>` +
    `<Hangup/>`,
  );
}

/**
 * A rep was rung but didn't pick up (busy/no-answer/timeout) — the caller is
 * still on the line at this point (this is the Dial `action` callback, not
 * the final hangup), so play a courtesy message before ending the call
 * instead of just going silent.
 */
export function noAnswerFallbackXml(): Response {
  return xml(
    `<Speak voice="WOMAN" language="en-US">All of our representatives are busy at this moment, we will call you back.</Speak>` +
    `<Hangup/>`,
  );
}

export function hangupXml(): Response {
  return xml(`<Hangup/>`);
}

// ---------------------------------------------------------------------------
// Signature verification (HMAC-SHA1 of URL + sorted params)
// ---------------------------------------------------------------------------

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** V1 signature: base64(HMAC-SHA1(token, url + sorted key+value params)). */
export function verifyPlivoSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  if (!AUTH_TOKEN) return true; // dev: skip if no token configured
  const sorted = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac("sha1", AUTH_TOKEN).update(sorted).digest("base64");
  return timingSafeEqual(expected, signature);
}

/** V2 signature: base64(HMAC-SHA256(token, url)). */
export function verifyPlivoSignatureV2(url: string, signature: string): boolean {
  if (!AUTH_TOKEN) return true;
  const expected = crypto.createHmac("sha256", AUTH_TOKEN).update(url).digest("base64");
  return timingSafeEqual(expected, signature);
}

/**
 * Reconstruct the exact public URL Plivo signed (the answer/hangup/record URL we
 * handed it, built from PLIVO_WEBHOOK_BASE_URL) — NOT `req.url`, which reflects
 * the internal host behind a proxy and would never match the signature.
 */
export function plivoSignedUrl(pathWithQuery: string): string {
  const base = (process.env.PLIVO_WEBHOOK_BASE_URL ?? process.env.NEXTAUTH_URL ?? "").replace(/\/+$/, "");
  return `${base}${pathWithQuery}`;
}

/**
 * Verify an inbound Plivo webhook. Accepts either the V2 (SHA-256) or the legacy
 * V1 (SHA-1) signature so it works regardless of the account's signature version.
 * When no auth token is configured we skip in dev but REFUSE in production
 * (an unverifiable webhook must not be trusted with a live token absent).
 */
export function verifyPlivoRequest(
  pathWithQuery: string,
  params: Record<string, string>,
  headers: Headers,
): boolean {
  if (!AUTH_TOKEN) return process.env.NODE_ENV !== "production";
  const url = plivoSignedUrl(pathWithQuery);
  const v2 = headers.get("x-plivo-signature-v2");
  if (v2 && verifyPlivoSignatureV2(url, v2)) return true;
  const v1 = headers.get("x-plivo-signature");
  if (v1 && verifyPlivoSignature(url, params, v1)) return true;
  return false;
}

/** Collect POST form fields into a plain record for signature verification. */
export function formToParams(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) out[k] = String(v);
  return out;
}

export function plivoConfigured(): boolean {
  return Boolean(AUTH_ID && AUTH_TOKEN && PLIVO_NUMBER);
}
