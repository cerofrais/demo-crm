/**
 * Plivo webhook: the customer answered the second leg placed by
 * outbound-answer. Plays the legally-required greeting, then joins the
 * same conference room the rep is already waiting in.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { outboundCustomerConferenceXml, hangupXml, verifiedPlivoBase, formToParams } from "@/lib/plivo";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const signedBase = verifiedPlivoBase(req.nextUrl.pathname + req.nextUrl.search, formToParams(form), req.headers);
  if (signedBase === null) {
    logger.warn({ path: req.nextUrl.pathname }, "plivo outbound-customer-answer: invalid signature");
    return new Response("Forbidden", { status: 403 });
  }

  const callId = req.nextUrl.searchParams.get("callId");
  if (!callId) {
    logger.warn({}, "outbound-customer-answer: missing callId — hanging up");
    return hangupXml();
  }

  await prisma.call.update({
    where: { id: callId },
    data: { status: "connected" },
  }).catch(() => null);

  // Build call-flow URLs on the origin Plivo actually reached us through,
  // not the configured primary — otherwise a fallback-routed call sends the
  // next hop back to the tunnel that just failed.
  const appUrl = signedBase;
  logger.info({ callId }, "outbound-customer-answer: customer picked up, joining conference");
  return outboundCustomerConferenceXml(`call-${callId}`, `${appUrl}/api/plivo/hold-tone`);
}
