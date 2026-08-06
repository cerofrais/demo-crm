/**
 * Plivo webhook: the rep's leg ended — the authoritative finalizer for an
 * outbound call (duration, recording, final status).
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPlivoRequest, formToParams, isSafeRecordingUrl } from "@/lib/plivo";
import { logger } from "@/lib/logger";
import type { CallStatus } from "@prisma/client";

export const runtime = "nodejs";

const IN_FLIGHT_STATUSES = new Set(["initiated", "ringing", "connected"]);

export async function POST(req: NextRequest) {
  const form = await req.formData();
  if (!verifyPlivoRequest(req.nextUrl.pathname + req.nextUrl.search, formToParams(form), req.headers)) {
    logger.warn({ path: req.nextUrl.pathname }, "plivo outbound-hangup: invalid signature");
    return new Response("Forbidden", { status: 403 });
  }
  const callUUID = form.get("CallUUID") as string | null;
  const rawData = form.get("CustomData") as string | null;
  const duration = parseInt((form.get("Duration") as string | null) ?? "0", 10);
  const rawRecordingUrl = (form.get("RecordingUrl") as string | null) ??
    (form.get("RecordingURL") as string | null) ??
    null;
  const recordingUrl = rawRecordingUrl && isSafeRecordingUrl(rawRecordingUrl) ? rawRecordingUrl : null;
  if (rawRecordingUrl && !recordingUrl) {
    logger.warn({ callUUID }, "outbound-hangup: rejected unsafe recording URL");
  }
  const callState = form.get("CallStatus") as string | null;

  let customData: { callId?: string } = {};
  try { customData = JSON.parse(rawData ?? "{}"); } catch { /* ignore */ }

  logger.info({ callUUID, callState, duration, hasRecording: Boolean(recordingUrl) }, "plivo outbound-hangup");

  const where = customData.callId
    ? { id: customData.callId }
    : callUUID
      ? { callUUID }
      : null;
  if (!where) return new Response("OK", { status: 200 });

  // If outbound-customer-hangup already finalized this call as no_answer
  // (customer's leg never connected, so we REST-hung-up the rep's leg
  // ourselves) don't let this event — which fires as a side effect of that
  // same hangup — overwrite it back to "completed".
  const current = await prisma.call.findUnique({
    where,
    select: { status: true, guestId: true, enquiryId: true, repKeycloakId: true, repName: true, customerPhone: true },
  }).catch(() => null);
  const alreadyFinalized = current && !IN_FLIGHT_STATUSES.has(current.status);

  const finalStatus: CallStatus = alreadyFinalized
    ? current.status
    : callState === "no-answer" ? "no_answer"
    : callState === "failed" ? "failed"
    : callState === "busy" ? "failed"
    : "completed";

  await prisma.call.update({
    where,
    data: {
      status: finalStatus,
      durationSec: duration,
      endedAt: new Date(),
      ...(recordingUrl && { recordingUrl, recordingDurSec: duration }),
      ...(callUUID && { callUUID }),
    },
  }).catch(() => null);

  // The rep placing the call is a staff action worth showing up in the
  // Activity Log/Performance report — previously only a MISSED call ever
  // wrote an Activity row (as a system event), so every outbound call a rep
  // actually made was invisible there. Only on genuine first finalization,
  // not a replayed webhook for a call already accounted for.
  if (!alreadyFinalized && current?.guestId && current.repKeycloakId) {
    const rep = await prisma.staffProfile
      .findUnique({ where: { keycloakId: current.repKeycloakId }, select: { role: true } })
      .catch(() => null);
    await prisma.activity.create({
      data: {
        guestId: current.guestId,
        enquiryId: current.enquiryId,
        actorSub: current.repKeycloakId,
        actorRole: rep?.role ?? "STAFF",
        actorName: current.repName ?? "Staff",
        actionType: "call_made",
        metadata: { status: finalStatus, durationSec: duration, customerPhone: current.customerPhone },
      },
    }).catch(() => null);
  }

  return new Response("OK", { status: 200 });
}
