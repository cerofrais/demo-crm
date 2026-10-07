/**
 * GET/POST /api/webhooks/whatsapp-cloud-relay — the URL currently registered
 * in the Meta app dashboard, kept alive under its old name because changing
 * it there costs a re-verification handshake. Identical behaviour to
 * /api/webhooks/whatsapp-cloud; both call the same handlers.
 *
 * "relay" was accurate when this route forwarded Meta's payload on to
 * Evolution API's /webhook/meta. It no longer does — Cloud API numbers talk
 * to Meta directly now, in both directions. Repoint Meta at
 * /api/webhooks/whatsapp-cloud when convenient, then delete this file.
 */
import type { NextRequest } from "next/server";
import { handleMetaVerify, handleMetaWebhook } from "@/lib/whatsapp-cloud-webhook";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handleMetaVerify(req);
}

export async function POST(req: NextRequest) {
  return handleMetaWebhook(req);
}
