/**
 * Plivo webhook: waitSound callback for the outbound Conference bridge.
 * waitSound doesn't accept a raw audio file URL — Plivo POSTs here on
 * demand (each time a leg is left alone in the room) and expects an XML
 * document back, which is what actually gets played. See holdToneXml /
 * outboundRepConferenceXml / outboundCustomerConferenceXml in lib/plivo.ts.
 */
import { NextRequest } from "next/server";
import { holdToneXml, verifyPlivoRequest, formToParams } from "@/lib/plivo";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  if (!verifyPlivoRequest(req.nextUrl.pathname + req.nextUrl.search, formToParams(form), req.headers)) {
    logger.warn({ path: req.nextUrl.pathname }, "plivo hold-tone: invalid signature");
    return new Response("Forbidden", { status: 403 });
  }
  const appUrl = process.env.PLIVO_WEBHOOK_BASE_URL ?? process.env.NEXTAUTH_URL ?? "";
  return holdToneXml(`${appUrl}/sounds/hold-tone.wav`);
}
