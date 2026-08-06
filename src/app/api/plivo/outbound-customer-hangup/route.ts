/**
 * Plivo webhook: the customer's leg ended.
 *
 * If it ended WITHOUT ever reaching "connected" (outbound-customer-answer
 * never fired — no-answer/busy/failed on that leg), the rep is left alone
 * in the conference room with nothing to bridge them to: Conference-based
 * bridging has no Dial-style "nothing left to execute, so hang up"
 * fallthrough the way <Dial><Number> used to. Release the rep's leg via
 * REST and finalize the call as missed.
 *
 * If the customer DID connect and this is just them hanging up after a real
 * conversation, this is a no-op here — the rep's own hangup_url
 * (outbound-hangup) is the authoritative finalizer for a completed call.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPlivoRequest, formToParams, hangupCall } from "@/lib/plivo";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const NEVER_CONNECTED_STATUSES = new Set(["initiated", "ringing"]);

export async function POST(req: NextRequest) {
  const form = await req.formData();
  if (!verifyPlivoRequest(req.nextUrl.pathname + req.nextUrl.search, formToParams(form), req.headers)) {
    logger.warn({ path: req.nextUrl.pathname }, "plivo outbound-customer-hangup: invalid signature");
    return new Response("Forbidden", { status: 403 });
  }

  const callId = req.nextUrl.searchParams.get("callId");
  const callState = form.get("CallStatus") as string | null;
  logger.info({ callId, callState }, "plivo outbound-customer-hangup");

  if (!callId) return new Response("OK", { status: 200 });

  const call = await prisma.call.findUnique({
    where: { id: callId },
    select: { status: true, callUUID: true },
  }).catch(() => null);
  if (!call) return new Response("OK", { status: 200 });

  if (NEVER_CONNECTED_STATUSES.has(call.status)) {
    if (call.callUUID) {
      await hangupCall(call.callUUID).catch((err) =>
        logger.error({ callId, err }, "outbound-customer-hangup: failed to release rep leg"),
      );
    }
    await prisma.call.update({
      where: { id: callId },
      data: { status: "no_answer", endedAt: new Date() },
    }).catch(() => null);
  }

  return new Response("OK", { status: 200 });
}
