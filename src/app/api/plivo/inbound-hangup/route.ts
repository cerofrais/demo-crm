/**
 * Plivo webhook: inbound call ended.
 * Captures duration + recording URL. Also doubles as the <Dial> `action`
 * callback (see inboundAnswerXml) — Plivo posts here mid-call, with the
 * caller still on the line, when the rung rep never picked up.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { touchLead } from "@/lib/enquiries";
import {
  verifiedPlivoBase,
  formToParams,
  isSafeRecordingUrl,
  noAnswerFallbackXml,
  huntNextRepXml,
  hangupXml,
} from "@/lib/plivo";
import { completeNextRnrTask } from "@/lib/tasks";
import { createLeadFromCall, pickAvailableRep, type CallAssignmentRestriction } from "@/lib/calls";
import { getCallCategoryAssignmentSettings } from "@/lib/lead-assignment";
import { logger } from "@/lib/logger";
import type { CallStatus } from "@prisma/client";

export const runtime = "nodejs";

// DialStatus is only present on the <Dial> `action` callback — the caller is
// still connected when this fires. Its absence means this is the
// Application's final hangup_url, i.e. the call is genuinely over.
const MISSED_DIAL_STATUSES = new Set(["no-answer", "busy", "timeout", "cancel"]);
// "cancel" = the caller hung up before the rep answered — no one left to
// play a message to.
const PLAYABLE_MISSED_STATUSES = new Set(["no-answer", "busy", "timeout"]);
const IN_FLIGHT_STATUSES = new Set(["initiated", "ringing", "connected"]);

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const signedBase = verifiedPlivoBase(req.nextUrl.pathname + req.nextUrl.search, formToParams(form), req.headers);
  if (signedBase === null) {
    logger.warn({ path: req.nextUrl.pathname }, "plivo inbound-hangup: invalid signature");
    return new Response("Forbidden", { status: 403 });
  }
  const callUUID = form.get("CallUUID") as string | null;
  const dialStatus = form.get("DialStatus") as string | null;
  const callState = form.get("CallStatus") as string | null;

  logger.info({ callUUID, dialStatus, callState }, "plivo inbound-hangup");

  if (!callUUID) return new Response("OK", { status: 200 });

  if (dialStatus && MISSED_DIAL_STATUSES.has(dialStatus)) {
    const call = await prisma.call.findUnique({
      where: { callUUID },
      select: { id: true, guestId: true, enquiryId: true, customerPhone: true, repKeycloakId: true, repName: true },
    }).catch(() => null);
    if (!call) return new Response("OK", { status: 200 });

    // "cancel" = the caller hung up before this rep answered — no one left
    // on the line to ring further or to play a message to. Otherwise, try
    // the next eligible rep who hasn't already been rung on this call
    // before giving up — see huntNextRepXml.
    if (dialStatus !== "cancel") {
      const tried = (req.nextUrl.searchParams.get("tried") ?? "").split(",").filter(Boolean);

      // Same "brand-new caller under a category restriction" rule
      // inbound-answer applied for the first rep — re-derived per hop
      // rather than stored, since nothing about it changes mid-call.
      let restrict: CallAssignmentRestriction | undefined;
      if (!call.guestId) {
        const callSettings = await getCallCategoryAssignmentSettings().catch(() => null);
        if (callSettings && callSettings.eligibleSubs.length > 0) {
          restrict = { subs: callSettings.eligibleSubs, strategy: callSettings.strategy };
        }
      }

      const nextRep = await pickAvailableRep(restrict, tried);
      if (nextRep) {
        await prisma.call.update({
          where: { callUUID },
          data: { repKeycloakId: nextRep.keycloakId, repName: nextRep.displayName, repPhone: nextRep.phone },
        }).catch(() => null);
        await prisma.activity.create({
          data: {
            guestId: call.guestId,
            enquiryId: call.enquiryId,
            actorSub: "plivo-call-routing",
            actorRole: "system",
            actorName: "Call routing",
            actionType: "call_hunt_next",
            metadata: { from: call.repName, to: nextRep.displayName, reason: dialStatus },
          },
        }).catch(() => null);

        // Build call-flow URLs on the origin Plivo actually reached us through,
  // not the configured primary — otherwise a fallback-routed call sends the
  // next hop back to the tunnel that just failed.
  const appUrl = signedBase;
        const nextTried = [...tried, nextRep.keycloakId].map(encodeURIComponent).join(",");
        logger.info({ callUUID, from: call.repKeycloakId, to: nextRep.keycloakId }, "plivo inbound-hangup: hunting to next rep");
        return huntNextRepXml(
          nextRep.phone,
          `${appUrl}/api/plivo/inbound-hangup?tried=${nextTried}`,
          `${appUrl}/api/plivo/recording-callback?callId=${call.id}`,
        );
      }
    }

    // "voicemail" here means "we played the busy/no-answer announcement",
    // not that the caller left one — the enum's closest fit for "an
    // automated message stood in for a live conversation."
    const missedStatus: CallStatus = dialStatus === "cancel" ? "no_answer" : "voicemail";
    await prisma.call.update({
      where: { callUUID },
      data: { status: missedStatus, endedAt: new Date() },
    }).catch(() => null);

    if (call.guestId) {
      await prisma.activity.create({
        data: {
          guestId: call.guestId,
          enquiryId: call.enquiryId,
          actorSub: "plivo-missed-call",
          actorRole: "system",
          actorName: "Missed call",
          actionType: "call_missed",
          metadata: { dialStatus, customerPhone: call.customerPhone },
        },
      }).catch(() => null);
    }

    return PLAYABLE_MISSED_STATUSES.has(dialStatus) ? noAnswerFallbackXml() : hangupXml();
  }

  const duration = parseInt((form.get("Duration") as string | null) ?? "0", 10);
  const rawRecordingUrl = (form.get("RecordingUrl") as string | null) ??
    (form.get("RecordingURL") as string | null) ??
    null;
  // Only persist a recording URL that points at a safe (non-internal) https host.
  const recordingUrl = rawRecordingUrl && isSafeRecordingUrl(rawRecordingUrl) ? rawRecordingUrl : null;
  if (rawRecordingUrl && !recordingUrl) {
    logger.warn({ callUUID }, "inbound-hangup: rejected unsafe recording URL");
  }

  // This route can fire a second time as the Application's final hangup_url
  // after we've already classified the call as missed/voicemail above —
  // Plivo reports the overall CallStatus as "completed" at that point (our
  // own Speak+Hangup technically completed), which would otherwise silently
  // overwrite the correct missed/voicemail status back to "completed".
  const current = await prisma.call.findUnique({
    where: { callUUID },
    select: {
      status: true,
      enquiryId: true,
      guestId: true,
      customerPhone: true,
      repKeycloakId: true,
      repName: true,
    },
  }).catch(() => null);
  const alreadyClassified = current && !IN_FLIGHT_STATUSES.has(current.status);

  const finalStatus: CallStatus = alreadyClassified
    ? current.status
    : callState === "no-answer" || callState === "busy" || callState === "timeout" ? "no_answer"
    : callState === "failed" ? "failed"
    : "completed";

  await prisma.call.update({
    where: { callUUID },
    data: {
      status: finalStatus,
      durationSec: duration,
      endedAt: new Date(),
      ...(recordingUrl && { recordingUrl, recordingDurSec: duration }),
    },
  }).catch(() => null);

  // A guest ringing in is activity on their lead whether or not anyone
  // reached them — float the card to the top of its column. Guarded on the
  // genuine finalization so a replayed webhook doesn't keep re-floating it.
  if (!alreadyClassified) await touchLead(current?.enquiryId);

  // Only on the genuine finalization moment, not a replayed/duplicate
  // webhook for a call that was already accounted for.
  if (!alreadyClassified && finalStatus === "completed" && current?.enquiryId) {
    await completeNextRnrTask(current.enquiryId).catch((err) =>
      logger.error({ err, enquiryId: current.enquiryId }, "inbound-hangup: failed to advance RNR cadence"),
    );
  }

  // A call that connected from a number with no existing lead becomes a new
  // one, owned by whoever actually answered — mirrors WhatsApp/email
  // auto-capture, but assigned directly instead of round-robin.
  let guestId = current?.guestId ?? null;
  let enquiryId = current?.enquiryId ?? null;
  if (!alreadyClassified && finalStatus === "completed" && current && !current.guestId) {
    await createLeadFromCall(callUUID, current.customerPhone, current.repKeycloakId, current.repName);
    const linked = await prisma.call
      .findUnique({ where: { callUUID }, select: { guestId: true, enquiryId: true } })
      .catch(() => null);
    guestId = linked?.guestId ?? null;
    enquiryId = linked?.enquiryId ?? null;
  }

  // The rep who answered is a staff action worth showing up in the Activity
  // Log/Performance report — previously only a MISSED inbound call ever
  // wrote an Activity row (as a system event); an answered one was invisible.
  if (!alreadyClassified && finalStatus === "completed" && current?.repKeycloakId && guestId) {
    const rep = await prisma.staffProfile
      .findUnique({ where: { keycloakId: current.repKeycloakId }, select: { role: true } })
      .catch(() => null);
    await prisma.activity.create({
      data: {
        guestId,
        enquiryId,
        actorSub: current.repKeycloakId,
        actorRole: rep?.role ?? "STAFF",
        actorName: current.repName ?? "Staff",
        actionType: "call_answered",
        metadata: { status: finalStatus, durationSec: duration, customerPhone: current.customerPhone },
      },
    }).catch(() => null);
  }

  return new Response("OK", { status: 200 });
}
