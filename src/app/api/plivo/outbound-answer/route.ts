/**
 * Plivo webhook: rep answered the outbound call.
 * Places a SECOND, independent call to the customer (its own answer_url
 * plays the legally-required greeting before bridging), then responds with
 * XML putting the rep's leg into a conference room to wait for them.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  outboundRepConferenceXml,
  hangupXml,
  verifyPlivoRequest,
  formToParams,
  isE164,
  createCall,
} from "@/lib/plivo";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  if (!verifyPlivoRequest(req.nextUrl.pathname + req.nextUrl.search, formToParams(form), req.headers)) {
    logger.warn({ path: req.nextUrl.pathname }, "plivo outbound-answer: invalid signature");
    return new Response("Forbidden", { status: 403 });
  }
  const callUUID = form.get("CallUUID") as string | null;
  const rawData = form.get("CustomData") as string | null;

  let customData: { callId?: string; customerPhone?: string } = {};
  try { customData = JSON.parse(rawData ?? "{}"); } catch { /* ignore */ }

  logger.info({ callUUID, callId: customData.callId }, "plivo outbound-answer webhook");

  const { callId } = customData;
  let { customerPhone } = customData;

  // Plivo does NOT echo custom_data in answer_url webhooks — look up the call
  // record from the DB using callUUID (request_uuid == CallUUID for outbound).
  if (!customerPhone && callUUID) {
    const dbCall = await prisma.call.findUnique({
      where: { callUUID },
      select: { id: true, customerPhone: true },
    }).catch(() => null);
    if (dbCall?.customerPhone) customerPhone = dbCall.customerPhone;
  }

  if (!customerPhone) {
    logger.warn({ callUUID }, "outbound-answer: no customerPhone — hanging up");
    return hangupXml();
  }
  if (!isE164(customerPhone)) {
    // Never splice a non-E.164 value into a call request — reject the leg.
    logger.warn({ callUUID }, "outbound-answer: customerPhone is not valid E.164 — hanging up");
    return hangupXml();
  }

  // Mark call as ringing / answered
  const updateWhere = callId ? { id: callId } : callUUID ? { callUUID } : null;
  if (updateWhere) {
    await prisma.call.update({
      where: updateWhere as Parameters<typeof prisma.call.update>[0]["where"],
      data: {
        ...(callUUID ? { callUUID } : {}),
        status: "ringing",
        answeredAt: new Date(),
      },
    }).catch(() => null);
  }

  // Resolve the best callId we have — needed to name the conference room and
  // to build the customer leg's own webhook URLs.
  const resolvedCallId = callId
    ?? (callUUID
        ? (await prisma.call.findUnique({ where: { callUUID }, select: { id: true } }).catch(() => null))?.id
        : null);

  if (!resolvedCallId) {
    logger.warn({ callUUID }, "outbound-answer: no resolvable callId — hanging up");
    return hangupXml();
  }

  const appUrl = process.env.PLIVO_WEBHOOK_BASE_URL ?? process.env.NEXTAUTH_URL ?? "";
  const roomName = `call-${resolvedCallId}`;

  try {
    const customerCall = await createCall({
      to: customerPhone,
      answerUrl: `${appUrl}/api/plivo/outbound-customer-answer?callId=${resolvedCallId}`,
      hangupUrl: `${appUrl}/api/plivo/outbound-customer-hangup?callId=${resolvedCallId}`,
      customData: JSON.stringify({ callId: resolvedCallId }),
      ringTimeout: 45,
    });
    logger.info({ callId: resolvedCallId, requestUUID: customerCall.requestUUID }, "outbound-answer: placed customer leg");
  } catch (err) {
    // Nothing will ever join the rep in the conference — don't leave them
    // waiting on a dead room.
    logger.error({ callId: resolvedCallId, err }, "outbound-answer: failed to place customer leg");
    await prisma.call.update({
      where: { id: resolvedCallId },
      data: { status: "failed", endedAt: new Date() },
    }).catch(() => null);
    return hangupXml();
  }

  const recCbUrl = `${appUrl}/api/plivo/recording-callback?callId=${resolvedCallId}`;
  const waitSoundUrl = `${appUrl}/api/plivo/hold-tone`;
  logger.info({ callUUID, resolvedCallId }, "outbound-answer: returning conference XML");
  return outboundRepConferenceXml(roomName, recCbUrl, waitSoundUrl);
}
