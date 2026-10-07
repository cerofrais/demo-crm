/**
 * POST /api/plivo/recording-callback
 * Plivo fires this asynchronously once the recording file is ready.
 * We embed `callId` as a query param when we build the URL so we always have
 * a reliable DB key, falling back to `CallUUID` only when callId is absent.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPlivoRequest, formToParams, isSafeRecordingUrl } from "@/lib/plivo";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const params = formToParams(form);
  if (!verifyPlivoRequest(req.nextUrl.pathname + req.nextUrl.search, params, req.headers)) {
    logger.warn({ path: req.nextUrl.pathname }, "plivo recording-callback: invalid signature");
    return new Response("Forbidden", { status: 403 });
  }

  // callId is embedded as a query param in the URL we passed to Plivo.
  const callId = req.nextUrl.searchParams.get("callId") ?? null;
  const callUUID = (form.get("CallUUID") as string | null) ?? null;

  // This URL is now the <Conference callbackUrl>, so it also receives every
  // other conference event — enter, exit, digits, and the record STOP. Only
  // the record events carry a recording; the rest are dropped quietly rather
  // than logging "no RecordingUrl in payload" several times per call.
  const conferenceAction = (form.get("ConferenceAction") as string | null) ?? null;
  if (conferenceAction && conferenceAction !== "record") {
    return new Response("OK", { status: 200 });
  }

  // Plivo <Record> sends RecordUrl (not RecordingUrl)
  const rawRecordingUrl =
    (form.get("RecordUrl") as string | null) ??
    (form.get("RecordingUrl") as string | null) ??
    (form.get("RecordingURL") as string | null) ??
    null;
  // Never persist an attacker-planted URL — fetchRecording would later hit it.
  const recordingUrl =
    rawRecordingUrl && isSafeRecordingUrl(rawRecordingUrl) ? rawRecordingUrl : null;
  if (rawRecordingUrl && !recordingUrl) {
    logger.warn({ callId, callUUID }, "recording-callback: rejected unsafe recording URL");
  }
  logger.info({ callId, callUUID, hasRecording: Boolean(recordingUrl) }, "plivo recording-callback received");
  const durationRaw =
    (form.get("RecordingDuration") as string | null) ??
    (form.get("Duration") as string | null) ??
    "0";
  // Plivo posts the record event when recording STARTS as well as when it
  // ends, and the start event carries a zero duration. Writing that over a
  // real duration would undo it, so a non-positive value is left alone.
  const parsedDuration = parseInt(durationRaw, 10);
  const duration = Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : null;

  if (!recordingUrl) {
    logger.warn({ callId, callUUID }, "recording-callback: no RecordingUrl in payload");
    return new Response("OK", { status: 200 });
  }

  if (!callId && !callUUID) {
    logger.warn({}, "recording-callback: no callId or CallUUID — cannot update record");
    return new Response("OK", { status: 200 });
  }

  try {
    if (callId) {
      await prisma.call.update({
        where: { id: callId },
        data: { recordingUrl, ...(duration !== null ? { recordingDurSec: duration } : {}) },
      });
      // Don't log recordingUrl — it embeds the Plivo AUTH_ID in its path (PII/secret).
      logger.info({ callId, duration }, "recording saved via callId");
    } else {
      // Fallback: look up by Plivo's CallUUID.
      await prisma.call.update({
        where: { callUUID: callUUID! },
        data: { recordingUrl, ...(duration !== null ? { recordingDurSec: duration } : {}) },
      });
      logger.info({ callUUID, duration }, "recording saved via callUUID");
    }
  } catch (err) {
    logger.error({ callId, callUUID, err }, "recording-callback: db update failed");
  }

  return new Response("OK", { status: 200 });
}
